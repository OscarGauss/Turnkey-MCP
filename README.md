# Turnkey Read-Only MCP Server

A self-hosted, **read-only** [MCP](https://modelcontextprotocol.io) server that lets any MCP client answer questions about your [Turnkey](https://turnkey.com) organization:

- How many sub-organizations do we have, and how many are created each month?
- How many wallets / wallet accounts per sub-org?
- How many signatures per month, and how many are mainnet vs testnet?
- How many sub-orgs were active in the last 30 days?
- How many sub-orgs should we expect in 3 and 6 months?

It only calls Turnkey **query** endpoints (`/public/v1/query/*`). There is no code path that submits an activity, so it cannot sign, create, or delete anything.

---

## How it works

```
MCP client ──HTTPS──▶ /mcp (Streamable HTTP, OAuth 2.1) ──▶  in-memory snapshot
                                                               ▲
                            background scanner (every 6 hours) ┘──▶ Turnkey query API
```

Scanning a large organization takes many API calls, so a background job builds a snapshot at startup and refreshes it periodically. Tool calls answer instantly from that snapshot. Turnkey rate-limits per organization, so the scanner shares that quota with your production services: it sends one request at a time by default, at most `SCAN_MAX_REQUESTS_PER_SECOND`, and pauses for a minute whenever Turnkey answers `429`.

## Tools

| Tool | What it returns |
|---|---|
| `usage_summary` | Everything below in one call. Start here. |
| `sub_org_growth` | Sub-orgs today, created per month, average of the last 3 full months, current-month pace. |
| `project_sub_orgs` | Sub-orgs expected in N months, linear at the latest rate and at the 3-month average, optional `monthly_growth_pct`. |
| `wallet_distribution` | Wallets and accounts per sub-org (avg, median, p90, max, histogram), accounts by address format. |
| `signature_stats` | Signatures per month and last 30 days, split mainnet / testnet / unknown, by type and by network. |
| `active_sub_orgs` | Sub-orgs with any activity, and with at least one signature, in the last N days. |
| `refresh_data` | Reports scan progress; starts a new scan only if the last one began 60+ minutes ago (5 after a failure). |

---

## 1. Create a dedicated, non-root Turnkey user

> ⚠️ **Do not use an API key on your Root user.** Root users bypass Turnkey's policy engine, so a leaked root key can sign transactions and change your organization.

Turnkey query endpoints are not subject to the policy engine: any authenticated user in the organization can read its data, and the parent organization can read all of its sub-organizations. Activities (signing, creating, deleting), on the other hand, are **deny-by-default** for non-root users. So a non-root user **with no policies** is effectively a read-only user.

1. In the Turnkey dashboard, go to **Users** and add a new user, e.g. `mcp-readonly`.
2. **Do not** add it to the root quorum. Do not give it tags or policies.
3. Open that user and create an API key for it. Copy the public and private key (the private key is shown only once).
4. Copy your **parent organization ID** (user menu, top right).
5. Optional but recommended: review **Policies** and make sure no existing policy allows activities for all users (e.g. a policy whose consensus is `true`), which would also apply to this user.

If the key ever leaks, an attacker can read your organization's metadata (sub-org IDs, addresses, activity history) but cannot move funds. Delete the key in the dashboard to revoke it.

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # paste as MCP_AUTH_TOKEN
```

| Variable | Required | Description |
|---|---|---|
| `TURNKEY_ORGANIZATION_ID` | ✅ | Parent organization ID |
| `TURNKEY_API_PUBLIC_KEY` | ✅ | Public key of the non-root user's API key |
| `TURNKEY_API_PRIVATE_KEY` | ✅ | Private key of that API key |
| `MCP_AUTH_TOKEN` | ✅ | Access token (≥ 32 chars): typed on the sign-in page, or sent as a bearer token |
| `PUBLIC_URL` | ✅ | Public base URL, e.g. `https://turnkey-mcp.example.com` (`http://localhost:3000` locally) |
| `PORT` | | Default `3000` |
| `TRUST_PROXY` | | Reverse proxies in front of the app. Default `1`; `0` if clients connect directly |
| `SCAN_WINDOW_DAYS` | | Signing history kept in memory. Default `180` |
| `SCAN_INTERVAL_MINUTES` | | Background refresh. Default `360` (6 hours) |
| `SCAN_CONCURRENCY` | | Turnkey requests in flight. Default `1`. Turnkey rate-limits per organization, so the scan shares its quota with your production services; raise it with care |
| `SCAN_MAX_REQUESTS_PER_SECOND` | | Cap on request starts per second. Default `4` |
| `TESTNET_CHAIN_IDS` / `MAINNET_CHAIN_IDS` | | Extra EVM chain IDs to classify, comma-separated |

## 3. Run

**Locally (Node ≥ 20):**

```bash
npm ci
npm run dev
curl http://localhost:3000/health
```

**Docker:**

```bash
docker compose up -d --build
```

## 4. Deploy

The image is a plain Docker container listening on `PORT` (default `3000`), so it runs on any Docker host or PaaS (Dokploy, Coolify, Railway, Fly.io, a VPS with Compose, ...):

1. Push this repo to GitHub/GitLab (your fork is fine; `.env` is git-ignored).
2. Create an application that builds from the `Dockerfile`, or a Compose service from `docker-compose.yml`.
3. Set the environment variables from your `.env`.
4. Put it behind your domain (e.g. `turnkey-mcp.example.com`) with HTTPS, pointing at container port `3000`.
5. Check `https://turnkey-mcp.example.com/health`; `snapshot` becomes a timestamp when the first scan finishes.

> Always serve the MCP endpoint over HTTPS, and set `PUBLIC_URL` to that HTTPS address.

## 5. Connect an MCP client

The MCP endpoint is `https://your-domain/mcp` (Streamable HTTP). It follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization) (OAuth 2.1), so there are two ways in:

**OAuth (clients that support it):** add only the URL `https://your-domain/mcp`. The client discovers the authorization server, registers itself and opens a sign-in page in your browser. Paste `MCP_AUTH_TOKEN` there once. The client then gets its own access token (1 hour) and refresh token (30 days) and renews them on its own.

**Bearer header (clients that take custom headers):** send `MCP_AUTH_TOKEN` directly. Most clients take a JSON config like this:

```json
{
  "mcpServers": {
    "turnkey": {
      "type": "http",
      "url": "https://your-domain/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Then ask your assistant for the Turnkey usage summary.

The token never goes in the URL. Every person you give `MCP_AUTH_TOKEN` to gets the same read-only access. To cut everyone off, set a new `MCP_AUTH_TOKEN` and restart: all OAuth tokens are signed with a key derived from it, so they stop working at once.

---

## How the numbers are calculated

- **Sub-orgs today:** `list_suborgs` on the parent organization.
- **Created per month:** dates of completed `CREATE_SUB_ORGANIZATION*` activities in the parent. Sub-orgs without such an activity fall back to their earliest wallet's creation date (reported in the output).
- **Wallets per sub-org:** `list_wallets` and `list_wallet_accounts` for every sub-org.
- **Signatures:** completed signing activities (`SIGN_RAW_PAYLOAD*`, `SIGN_TRANSACTION*`, `ETH_SEND_*`, `SOL_SEND_*`) in the parent and every sub-org. `SIGN_RAW_PAYLOADS` counts each payload. Totals may differ slightly from the dashboard's billing counter.
- **Mainnet vs testnet:** known only when Turnkey sees the network: send-transaction activities carry a CAIP-2 chain ID, and EVM unsigned transactions are decoded for their chain ID (classified with viem's chain registry). Raw-payload and message signatures, and Solana `SIGN_TRANSACTION`, don't include the network and are reported as `unknown`. If most of your volume is raw payloads, get the split from your own backend.
- **Active sub-orgs:** a sub-org with any activity (session/login, signing, wallet creation…) in the window; also reported: sub-orgs with at least one signature.
- **Projection:** today + new sub-orgs per month × months, at two rates: the latest one (the current month's pace once it has 7 days of data, otherwise the last full month) and the average of the last 3 full months. With `monthly_growth_pct`, new sub-orgs per month start at the latest rate and grow by that percentage each month.

All months are UTC.

## Troubleshooting

- `/health` shows `phase: "failed"`: check the organization ID and API key; the `refresh_data` tool shows `last_error`. A failed scan is retried every 5 minutes.
- Rate-limit errors (`429 Resource exhausted`): the scanner pauses for a minute on each one; if they persist, lower `SCAN_CONCURRENCY` or raise `SCAN_INTERVAL_MINUTES`.
- 401 from `/mcp`: the bearer token doesn't match `MCP_AUTH_TOKEN`, or the OAuth token expired and the client didn't refresh it (reconnect it).
- OAuth sign-in fails or redirects to the wrong host: `PUBLIC_URL` must be the exact public HTTPS address clients use.

## License

MIT
