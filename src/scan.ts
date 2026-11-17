// Collects everything the analytics need in one pass and keeps it in memory.
// Tools read from this snapshot, so MCP calls answer instantly even with thousands of sub-orgs.

import { config } from "./config.js";
import {
  getAllWalletAccounts, getWallets, listActivitiesSince, listSubOrgIds, mapLimit, tsMs, type Activity,
} from "./turnkey.js";
import { classifyActivity, signatureCount, type NetworkClass } from "./networks.js";

export const SIGNING_TYPES = [
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOADS",
  "ACTIVITY_TYPE_SIGN_TRANSACTION",
  "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  "ACTIVITY_TYPE_ETH_SEND_TRANSACTION",
  "ACTIVITY_TYPE_ETH_SEND_TRANSACTION_V2",
  "ACTIVITY_TYPE_ETH_SEND_RAW_TRANSACTION",
  "ACTIVITY_TYPE_SOL_SEND_TRANSACTION",
  "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2",
] as const;

const CREATE_SUB_ORG_TYPES = [
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V2",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V3",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V5",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V6",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
] as const;

export interface SignatureEvent {
  atMs: number;
  type: string;
  count: number;
  network: NetworkClass;
  networkLabel: string;
}

export interface OrgSnapshot {
  organizationId: string;
  isParent: boolean;
  createdAtMs?: number; // from the parent's CREATE_SUB_ORGANIZATION activity, else earliest wallet
  createdAtSource?: "activity" | "earliest_wallet";
  wallets: number;
  accounts: number;
  addressFormats: Record<string, number>;
  lastActivityMs?: number;
  signatures: SignatureEvent[];
  error?: string;
}

export interface Snapshot {
  startedAt: string;
  finishedAt: string;
  windowDays: number;
  windowStartMs: number;
  parent: OrgSnapshot;
  subOrgs: OrgSnapshot[];
  errors: number;
}

let current: Snapshot | undefined;
let running: Promise<Snapshot> | undefined;
let progress = { done: 0, total: 0, phase: "idle" as string, lastError: undefined as string | undefined };

export const getSnapshot = () => current;
export const getProgress = () => ({ ...progress, running: Boolean(running) });

function findSubOrgId(a: Activity): string | undefined {
  const r: any = a.result ?? {};
  for (const v of Object.values(r)) {
    const id = (v as any)?.subOrganizationId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

async function scanOrg(orgId: string, isParent: boolean, windowStartMs: number): Promise<OrgSnapshot> {
  const snap: OrgSnapshot = { organizationId: orgId, isParent, wallets: 0, accounts: 0, addressFormats: {}, signatures: [] };
  try {
    // One request at a time per org: SCAN_CONCURRENCY is then the number of requests in flight.
    const wallets = await getWallets(orgId);
    const accounts = await getAllWalletAccounts(orgId);
    const signing = await listActivitiesSince(orgId, windowStartMs, { types: [...SIGNING_TYPES], completedOnly: true });
    const latest = await listActivitiesSince(orgId, 0, { stopAtFirst: true });
    snap.wallets = wallets.length;
    snap.accounts = accounts.length;
    for (const acc of accounts) {
      const f = String(acc.addressFormat).replace("ADDRESS_FORMAT_", "");
      snap.addressFormats[f] = (snap.addressFormats[f] ?? 0) + 1;
    }
    const walletDates = wallets.map((w) => tsMs(w.createdAt)).filter(Boolean);
    if (walletDates.length) {
      snap.createdAtMs = Math.min(...walletDates);
      snap.createdAtSource = "earliest_wallet";
    }
    snap.lastActivityMs = Math.max(0, ...latest.map((a) => tsMs(a.createdAt)), ...signing.map((a) => tsMs(a.createdAt))) || undefined;
    snap.signatures = signing.map((a) => {
      const net = classifyActivity(a);
      return { atMs: tsMs(a.createdAt), type: String(a.type).replace("ACTIVITY_TYPE_", ""), count: signatureCount(a), network: net.class, networkLabel: net.label };
    });
  } catch (err: any) {
    snap.error = String(err?.message ?? err);
    progress.lastError = snap.error;
  }
  return snap;
}

async function doScan(): Promise<Snapshot> {
  const started = new Date();
  const windowStartMs = started.getTime() - config.scanWindowDays * 86_400_000;
  progress = { done: 0, total: 0, phase: "listing sub-organizations", lastError: undefined };

  const subOrgIds = await listSubOrgIds();

  progress.phase = "reading sub-organization creation history";
  const created = new Map<string, number>();
  try {
    const creations = await listActivitiesSince(config.organizationId, 0, { types: [...CREATE_SUB_ORG_TYPES], completedOnly: true, maxPages: 2000 });
    for (const a of creations) {
      const id = findSubOrgId(a);
      if (id) created.set(id, tsMs(a.createdAt));
    }
  } catch (err: any) {
    progress.lastError = `creation history: ${err?.message ?? err}`;
  }

  progress.phase = "scanning organizations";
  progress.total = subOrgIds.length + 1;
  const parent = await scanOrg(config.organizationId, true, windowStartMs);
  progress.done = 1;

  const subOrgs = await mapLimit(subOrgIds, config.scanConcurrency, async (id) => {
    const s = await scanOrg(id, false, windowStartMs);
    const c = created.get(id);
    if (c) {
      s.createdAtMs = c;
      s.createdAtSource = "activity";
    }
    progress.done++;
    return s;
  });

  const snap: Snapshot = {
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    windowDays: config.scanWindowDays,
    windowStartMs,
    parent,
    subOrgs,
    errors: [parent, ...subOrgs].filter((s) => s.error).length,
  };
  progress.phase = "idle";
  return snap;
}

// A scan costs one request per page per org against a rate limit shared with production, so
// on-demand scans (refresh_data) are spaced out; the background schedule is not affected.
export const RETRY_AFTER_FAILURE_MINUTES = Math.min(5, config.scanIntervalMinutes);
const ON_DEMAND_MIN_AGE_MINUTES = 60;
let lastStartMs = 0;

/** Milliseconds until refresh_data may start a scan (0 = now). */
export function onDemandScanAllowedInMs(): number {
  const gapMinutes = current ? ON_DEMAND_MIN_AGE_MINUTES : RETRY_AFTER_FAILURE_MINUTES;
  return Math.max(0, lastStartMs + gapMinutes * 60_000 - Date.now());
}

/** Starts a scan unless one is already running. Returns the in-flight promise. */
export function startScan(): Promise<Snapshot> {
  if (!running) {
    lastStartMs = Date.now();
    running = doScan()
      .then((s) => {
        current = s;
        console.log(`[scan] done: ${s.subOrgs.length} sub-orgs, ${s.errors} errors, ${s.startedAt} → ${s.finishedAt}`);
        return s;
      })
      .catch((err) => {
        progress.phase = "failed";
        progress.lastError = String(err?.message ?? err);
        console.error("[scan] failed:", progress.lastError);
        throw err;
      })
      .finally(() => {
        running = undefined;
      });
  }
  return running;
}

/** Waits up to `ms` for the running scan, without starting one. Undefined if there is no snapshot yet. */
export async function snapshotWithin(ms: number): Promise<Snapshot | undefined> {
  if (current || !running) return current;
  const p = running.catch(() => undefined);
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}
