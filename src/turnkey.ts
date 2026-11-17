// Thin, READ-ONLY wrapper around the Turnkey public API.
// Only /public/v1/query/* endpoints are used. Nothing here submits activities.

import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { config } from "./config.js";

export const client = new TurnkeyClient(
  { baseUrl: config.turnkeyBaseUrl },
  new ApiKeyStamper({ apiPublicKey: config.apiPublicKey, apiPrivateKey: config.apiPrivateKey }),
);

export type Activity = Awaited<ReturnType<typeof client.getActivities>>["activities"][number];
export type Wallet = Awaited<ReturnType<typeof client.getWallets>>["wallets"][number];
export type WalletAccount = Awaited<ReturnType<typeof client.getWalletAccounts>>["accounts"][number];
type ActivityType = NonNullable<Parameters<typeof client.getActivities>[0]["filterByType"]>[number];

const PAGE = 100;

export const tsMs = (t?: { seconds: string; nanos?: string }): number =>
  t ? Number(t.seconds) * 1000 + Math.floor(Number(t.nanos ?? 0) / 1e6) : 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries on rate limits (429) and transient 5xx errors with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const retriable = /429|rate|too many|50[0-4]|timeout|ECONNRESET|fetch failed/i.test(msg);
      if (!retriable || attempt >= 6) throw new Error(`${label}: ${msg}`);
      await sleep(delay + Math.random() * 250);
      delay *= 2;
    }
  }
}

export async function listSubOrgIds(): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  while (true) {
    const res = await withRetry(
      () =>
        client.getSubOrgIds({
          organizationId: config.organizationId,
          paginationOptions: { limit: String(PAGE), ...(after ? { after } : {}) },
        }),
      "list_suborgs",
    );
    const page = res.organizationIds ?? [];
    ids.push(...page);
    if (page.length < PAGE || ids.length >= config.maxSubOrgs) break;
    after = page[page.length - 1];
  }
  return [...new Set(ids)];
}

export async function getWallets(organizationId: string): Promise<Wallet[]> {
  const res = await withRetry(() => client.getWallets({ organizationId }), `list_wallets ${organizationId}`);
  return res.wallets ?? [];
}

export async function getAllWalletAccounts(organizationId: string): Promise<WalletAccount[]> {
  const out: WalletAccount[] = [];
  let after: string | undefined;
  while (true) {
    const res = await withRetry(
      () =>
        client.getWalletAccounts({
          organizationId,
          paginationOptions: { limit: String(PAGE), ...(after ? { after } : {}) },
        }),
      `list_wallet_accounts ${organizationId}`,
    );
    const page = res.accounts ?? [];
    out.push(...page);
    if (page.length < PAGE || out.length > 50_000) break;
    after = page[page.length - 1].walletAccountId;
  }
  return out;
}

/**
 * Lists activities created at or after `sinceMs`. Works whether the API returns pages
 * newest-first or oldest-first (it detects the order from the first page).
 */
export async function listActivitiesSince(
  organizationId: string,
  sinceMs: number,
  opts: { types?: ActivityType[]; completedOnly?: boolean; stopAtFirst?: boolean; maxPages?: number } = {},
): Promise<Activity[]> {
  const out: Activity[] = [];
  let after: string | undefined;
  let order: "desc" | "asc" | undefined;
  const maxPages = opts.maxPages ?? 500;

  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const res = await withRetry(
      () =>
        client.getActivities({
          organizationId,
          ...(opts.types ? { filterByType: opts.types } : {}),
          ...(opts.completedOnly ? { filterByStatus: ["ACTIVITY_STATUS_COMPLETED"] } : {}),
          paginationOptions: { limit: String(PAGE), ...(after ? { after } : {}) },
        }),
      `list_activities ${organizationId}`,
    );
    const page = res.activities ?? [];
    if (page.length === 0) break;

    if (!order && page.length > 1) {
      order = tsMs(page[0].createdAt) >= tsMs(page[page.length - 1].createdAt) ? "desc" : "asc";
    }
    const inWindow = page.filter((a) => tsMs(a.createdAt) >= sinceMs);
    out.push(...inWindow);

    // Oldest-first pages hold the latest activity on the last page, so they are walked to the end.
    if (opts.stopAtFirst && out.length > 0 && order !== "asc") break;
    if (page.length < PAGE) break;
    // Newest-first: once a page reaches past the window, older pages are all outside it.
    if (order !== "asc" && inWindow.length < page.length) break;
    after = page[page.length - 1].id;
  }
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
