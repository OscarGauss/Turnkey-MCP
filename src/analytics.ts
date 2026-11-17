// Pure functions that turn a Snapshot into the numbers people ask for.

import type { Snapshot } from "./scan.js";

const DAY = 86_400_000;
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7); // YYYY-MM (UTC)

function lastMonths(n: number, now = Date.now()): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function freshness(s: Snapshot) {
  return {
    data_as_of: s.finishedAt,
    scan_window_days: s.windowDays,
    orgs_with_errors: s.errors,
    note: "Snapshot from the background scanner. Call refresh_data for newer numbers.",
  };
}

export function subOrgGrowth(s: Snapshot, months = 6) {
  const keys = lastMonths(months);
  const counts: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  let unknownDate = 0;
  let fromWalletFallback = 0;
  for (const o of s.subOrgs) {
    if (!o.createdAtMs) { unknownDate++; continue; }
    if (o.createdAtSource === "earliest_wallet") fromWalletFallback++;
    const k = monthKey(o.createdAtMs);
    if (k in counts) counts[k]++;
  }
  const now = new Date();
  const currentKey = monthKey(now.getTime());
  const fullMonths = keys.filter((k) => k !== currentKey);
  const last3 = fullMonths.slice(-3);
  const avgLast3 = last3.length ? last3.reduce((a, k) => a + counts[k], 0) / last3.length : 0;

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const currentPace = counts[currentKey] !== undefined ? (counts[currentKey] / dayOfMonth) * daysInMonth : 0;

  return {
    total_sub_orgs_today: s.subOrgs.length,
    created_per_month: counts,
    current_month: currentKey,
    current_month_projected_at_current_pace: round(currentPace, 0),
    avg_created_per_month_last_3_full_months: round(avgLast3, 1),
    sub_orgs_without_known_creation_date: unknownDate,
    creation_dates_estimated_from_earliest_wallet: fromWalletFallback,
  };
}

export function projection(s: Snapshot, horizons: number[] = [3, 6], monthlyGrowthPct?: number) {
  const g = subOrgGrowth(s, 6);
  const base = g.total_sub_orgs_today;
  const perMonth = g.avg_created_per_month_last_3_full_months;
  const out: Record<string, any> = {};
  for (const h of horizons) {
    const linear = base + perMonth * h;
    let compounding: number | undefined;
    if (monthlyGrowthPct !== undefined) {
      // New sub-orgs per month grow by monthlyGrowthPct each month.
      let total = base, adds = perMonth;
      for (let i = 0; i < h; i++) { adds *= 1 + monthlyGrowthPct / 100; total += adds; }
      compounding = total;
    }
    out[`in_${h}_months`] = {
      linear_at_recent_rate: Math.round(linear),
      ...(compounding !== undefined ? { with_growth_assumption: Math.round(compounding) } : {}),
    };
  }
  return {
    today: base,
    recent_new_sub_orgs_per_month: perMonth,
    assumption: monthlyGrowthPct !== undefined
      ? `Linear = today + recent monthly rate × months. Growth = monthly new sub-orgs grow ${monthlyGrowthPct}% per month.`
      : "Linear = today + average new sub-orgs per month (last 3 full months) × months. Pass monthly_growth_pct to model acceleration.",
    projections: out,
  };
}

export function walletDistribution(s: Snapshot) {
  const wallets = s.subOrgs.filter((o) => !o.error).map((o) => o.wallets);
  const accounts = s.subOrgs.filter((o) => !o.error).map((o) => o.accounts);
  const histogram: Record<string, number> = {};
  for (const w of wallets) {
    const k = w >= 5 ? "5+" : String(w);
    histogram[k] = (histogram[k] ?? 0) + 1;
  }
  const formats: Record<string, number> = {};
  for (const o of s.subOrgs) for (const [f, n] of Object.entries(o.addressFormats)) formats[f] = (formats[f] ?? 0) + n;

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    sub_orgs_counted: wallets.length,
    total_wallets_in_sub_orgs: sum(wallets),
    total_wallet_accounts_in_sub_orgs: sum(accounts),
    wallets_per_sub_org: { avg: round(sum(wallets) / (wallets.length || 1)), median: median(wallets), p90: percentile(wallets, 90), max: Math.max(0, ...wallets) },
    accounts_per_sub_org: { avg: round(sum(accounts) / (accounts.length || 1)), median: median(accounts), p90: percentile(accounts, 90), max: Math.max(0, ...accounts) },
    sub_orgs_by_wallet_count: histogram,
    accounts_by_address_format: formats,
    parent_org: { wallets: s.parent.wallets, accounts: s.parent.accounts },
  };
}

export function signatureStats(s: Snapshot, months = 3) {
  const keys = lastMonths(months).filter((k) => k >= monthKey(s.windowStartMs));
  const empty = () => ({ total: 0, mainnet: 0, testnet: 0, unknown: 0 });
  const perMonth: Record<string, ReturnType<typeof empty>> = Object.fromEntries(keys.map((k) => [k, empty()]));
  const byType: Record<string, number> = {};
  const byNetwork: Record<string, number> = {};
  const last30 = empty();
  const cutoff30 = Date.now() - 30 * DAY;

  for (const o of [s.parent, ...s.subOrgs]) {
    for (const e of o.signatures) {
      const k = monthKey(e.atMs);
      if (perMonth[k]) { perMonth[k].total += e.count; perMonth[k][e.network] += e.count; }
      if (e.atMs >= cutoff30) { last30.total += e.count; last30[e.network] += e.count; }
      byType[e.type] = (byType[e.type] ?? 0) + e.count;
      byNetwork[e.networkLabel] = (byNetwork[e.networkLabel] ?? 0) + e.count;
    }
  }
  return {
    last_30_days: last30,
    per_month: perMonth,
    by_activity_type_in_window: byType,
    by_network_in_window: Object.fromEntries(Object.entries(byNetwork).sort((a, b) => b[1] - a[1])),
    notes: [
      "Counts completed signing activities; SIGN_RAW_PAYLOADS counts each payload.",
      "Network is only known when Turnkey sees it (send-transaction activities, or EVM unsigned transactions). Raw payload / message signatures are 'unknown'.",
      "May differ slightly from the dashboard's billing counter, which uses Turnkey's own definition.",
    ],
  };
}

export function activeSubOrgs(s: Snapshot, days = 30) {
  const cutoff = Date.now() - days * DAY;
  const signedSince = (o: (typeof s.subOrgs)[number]) => o.signatures.some((e) => e.atMs >= cutoff);
  const signing = s.subOrgs.filter(signedSince);
  const active = s.subOrgs.filter((o) => (o.lastActivityMs ?? 0) >= cutoff || signedSince(o));
  const total = s.subOrgs.length || 1;
  return {
    days,
    total_sub_orgs: s.subOrgs.length,
    active_any_activity: active.length,
    active_any_activity_pct: round((active.length / total) * 100, 1),
    active_with_signatures: signing.length,
    active_with_signatures_pct: round((signing.length / total) * 100, 1),
    definition: "any activity = any Turnkey activity in the sub-org (login/session, signing, wallet creation, etc.). with_signatures = at least one completed signing activity.",
  };
}
