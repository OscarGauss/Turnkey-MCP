// Central configuration, read once from environment variables.

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[config] Missing required env var ${name}. See .env.example`);
    process.exit(1);
  }
  return v;
}

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[config] ${name} must be a positive number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

function intList(name: string): number[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
}

function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[config] PUBLIC_URL must be a full URL like https://turnkey-mcp.example.com, got "${raw}"`);
    process.exit(1);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    console.error("[config] PUBLIC_URL must use https:// (http:// is only allowed for localhost)");
    process.exit(1);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export const config = {
  // Turnkey
  turnkeyBaseUrl: process.env.TURNKEY_BASE_URL?.trim() || "https://api.turnkey.com",
  organizationId: required("TURNKEY_ORGANIZATION_ID"),
  apiPublicKey: required("TURNKEY_API_PUBLIC_KEY"),
  apiPrivateKey: required("TURNKEY_API_PRIVATE_KEY"),

  // HTTP / MCP
  port: num("PORT", 3000),
  authToken: required("MCP_AUTH_TOKEN"),
  publicUrl: publicUrl(required("PUBLIC_URL")),
  // Reverse proxies in front of the app; 0 when clients connect to it directly.
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),

  // Scanner
  scanWindowDays: num("SCAN_WINDOW_DAYS", 180),
  scanIntervalMinutes: num("SCAN_INTERVAL_MINUTES", 360),
  // Turnkey's rate limit is shared with every other client of the same organization.
  scanConcurrency: num("SCAN_CONCURRENCY", 1),
  scanMaxRequestsPerSecond: num("SCAN_MAX_REQUESTS_PER_SECOND", 4),
  maxSubOrgs: num("MAX_SUB_ORGS", 20000),

  // Network classification overrides (EVM chain IDs)
  extraTestnetChainIds: intList("TESTNET_CHAIN_IDS"),
  extraMainnetChainIds: intList("MAINNET_CHAIN_IDS"),
};

if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) {
  console.error(`[config] TRUST_PROXY must be a whole number of proxy hops (0 or more), got "${process.env.TRUST_PROXY}"`);
  process.exit(1);
}

if (config.authToken.length < 32) {
  console.error("[config] MCP_AUTH_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32");
  process.exit(1);
}
