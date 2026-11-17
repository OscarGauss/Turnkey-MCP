// MCP server definition: read-only tools over the latest Turnkey snapshot.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProgress, getSnapshot, onDemandScanAllowedInMs, snapshotWithin, startScan, type Snapshot } from "./scan.js";
import { activeSubOrgs, freshness, projection, signatureStats, subOrgGrowth, walletDistribution } from "./analytics.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function notReady() {
  const p = getProgress();
  const failed = p.phase === "failed";
  return json({
    status: failed ? "failed" : "scanning",
    message: failed
      ? "The scan of your Turnkey organization failed. Check last_error (API key, organization ID, network). It retries on its own every few minutes; refresh_data shows its progress."
      : "The first scan of your Turnkey organization is still running. Try again in a minute.",
    progress: `${p.done}/${p.total || "?"} organizations (${p.phase})`,
    last_error: p.lastError,
  });
}

async function withSnapshot(fn: (s: Snapshot) => unknown) {
  const s = await snapshotWithin(25_000);
  return s ? json({ ...((fn(s) as object) ?? {}), _freshness: freshness(s) }) : notReady();
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "turnkey-readonly", version: "0.1.0" });

  server.registerTool(
    "usage_summary",
    {
      title: "Turnkey usage summary",
      description:
        "One-shot overview of the Turnkey organization: sub-orgs today and created per month, wallets per sub-org, signatures per month (mainnet/testnet/unknown), active sub-orgs in the last 30 days, and a 3/6-month sub-org projection. Start here.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      withSnapshot((s) => ({
        sub_orgs: subOrgGrowth(s, 6),
        wallets: walletDistribution(s),
        signatures: signatureStats(s, 3),
        active_30d: activeSubOrgs(s, 30),
        projection: projection(s, [3, 6]),
      })),
  );

  server.registerTool(
    "sub_org_growth",
    {
      title: "Sub-organization growth",
      description: "Total sub-organizations today and how many were created in each of the last N months (UTC).",
      inputSchema: { months: z.number().int().min(1).max(36).default(6).describe("How many months back, including the current one") },
      annotations: READ_ONLY,
    },
    async ({ months }) => withSnapshot((s) => subOrgGrowth(s, months)),
  );

  server.registerTool(
    "project_sub_orgs",
    {
      title: "Project sub-organization count",
      description: "Projects the number of sub-orgs N months from now, from the recent creation rate and an optional growth assumption.",
      inputSchema: {
        horizons_months: z.array(z.number().int().min(1).max(36)).default([3, 6]),
        monthly_growth_pct: z.number().min(-100).max(1000).optional().describe("Optional month-over-month growth of NEW sub-orgs, e.g. 20 for +20%/month"),
      },
      annotations: READ_ONLY,
    },
    async ({ horizons_months, monthly_growth_pct }) => withSnapshot((s) => projection(s, horizons_months, monthly_growth_pct)),
  );

  server.registerTool(
    "wallet_distribution",
    {
      title: "Wallets per sub-org",
      description: "Wallets and wallet accounts per sub-organization (avg, median, p90, max, histogram) and accounts by address format.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => withSnapshot((s) => walletDistribution(s)),
  );

  server.registerTool(
    "signature_stats",
    {
      title: "Signature volume",
      description: "Completed signatures per month and in the last 30 days, split into mainnet / testnet / unknown, plus breakdown by activity type and network.",
      inputSchema: { months: z.number().int().min(1).max(12).default(3) },
      annotations: READ_ONLY,
    },
    async ({ months }) => withSnapshot((s) => signatureStats(s, months)),
  );

  server.registerTool(
    "active_sub_orgs",
    {
      title: "Active sub-orgs",
      description: "How many sub-organizations had any activity, and how many signed something, in the last N days.",
      inputSchema: { days: z.number().int().min(1).max(365).default(30) },
      annotations: READ_ONLY,
    },
    async ({ days }) => withSnapshot((s) => activeSubOrgs(s, days)),
  );

  server.registerTool(
    "refresh_data",
    {
      title: "Refresh / scan status",
      description:
        "Reports scan progress and starts a new scan of the Turnkey organization when the last one began at least 60 minutes ago (5 minutes after a failed scan). Scans share Turnkey's rate limit with production, so the snapshot is usually what to answer from.",
      inputSchema: { wait_seconds: z.number().int().min(0).max(50).default(40) },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    async ({ wait_seconds }) => {
      const before = getSnapshot()?.finishedAt;
      const allowedInMs = onDemandScanAllowedInMs();
      const p = getProgress().running || allowedInMs === 0 ? startScan().catch(() => undefined) : undefined;
      const s = p ? await Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), wait_seconds * 1000))]) : undefined;
      const prog = getProgress();
      return json({
        status: s ? "done" : prog.running ? "running" : prog.phase === "failed" ? "failed" : "not_started",
        ...(p ? {} : { next_scan_allowed_in_minutes: Math.ceil(allowedInMs / 60_000) }),
        previous_snapshot: before ?? null,
        current_snapshot: getSnapshot()?.finishedAt ?? null,
        progress: `${prog.done}/${prog.total || "?"} (${prog.phase})`,
        last_error: prog.lastError,
      });
    },
  );

  return server;
}
