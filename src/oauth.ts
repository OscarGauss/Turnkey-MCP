// OAuth 2.1 authorization server for the MCP endpoint, as the MCP authorization spec describes:
// protected resource metadata, dynamic client registration, authorization code + PKCE, refresh tokens.
//
// The only credential is MCP_AUTH_TOKEN. The login page asks for it once, and each client then
// gets its own short-lived access token. Clients that can send headers may also use
// MCP_AUTH_TOKEN directly as a bearer token.
//
// Everything is stateless: client IDs, authorization codes and tokens are HMAC-signed payloads
// keyed from MCP_AUTH_TOKEN, so nothing needs a database and rotating MCP_AUTH_TOKEN revokes
// every client and token at once.

import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.js";

export const mcpUrl = new URL("/mcp", config.publicUrl);
export const LOGIN_PATH = "/oauth/login";

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 60;
const LOGIN_FORM_TTL_S = 10 * 60;

const now = () => Math.floor(Date.now() / 1000);

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- signed payloads ----

const key = crypto.createHmac("sha256", config.authToken).update("turnkey-mcp oauth signing key v1").digest();
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const mac = (data: string) => crypto.createHmac("sha256", key).update(data).digest();

type Kind = "client" | "login" | "code" | "access" | "refresh";

function sign(kind: Kind, payload: Record<string, unknown>): string {
  const body = b64(JSON.stringify({ k: kind, ...payload }));
  return `${body}.${b64(mac(body))}`;
}

/** Returns the payload if the signature is valid, the kind matches and it has not expired. */
function verify<T extends Record<string, any>>(kind: Kind, token: string): T | undefined {
  const [body, sig] = token.split(".");
  if (!body || !sig) return undefined;
  const expected = mac(body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return undefined;
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (payload?.k !== kind) return undefined;
  if (typeof payload.exp === "number" && payload.exp < now()) return undefined;
  return payload as T;
}

// ---- clients (dynamic registration, encoded in the client_id) ----

const clientSecretFor = (clientId: string) => b64(mac(`client-secret:${clientId}`));

function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (["javascript:", "data:", "file:", "vbscript:"].includes(u.protocol)) return false;
  // Plain http only for loopback (native apps); custom schemes (cursor://, vscode://) are allowed.
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return true;
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    const p = verify<{ m: Partial<OAuthClientInformationFull>; iat: number }>("client", clientId);
    if (!p) return undefined;
    const confidential = p.m.token_endpoint_auth_method !== "none";
    return {
      ...p.m,
      redirect_uris: p.m.redirect_uris ?? [],
      client_id: clientId,
      client_id_issued_at: p.iat,
      ...(confidential ? { client_secret: clientSecretFor(clientId), client_secret_expires_at: 0 } : {}),
    } as OAuthClientInformationFull;
  },

  registerClient(client) {
    const uris = client.redirect_uris ?? [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect)) {
      throw new InvalidClientMetadataError("redirect_uris must be 1-10 https URLs, loopback http URLs, or app schemes");
    }
    const m = {
      redirect_uris: uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_post",
      grant_types: client.grant_types,
      response_types: client.response_types,
      client_name: client.client_name?.slice(0, 100),
      scope: client.scope,
    };
    const iat = now();
    const clientId = sign("client", { m, iat });
    return clientsStore.getClient(clientId) as OAuthClientInformationFull;
  },
};

// ---- tokens ----

function issueTokens(clientId: string, scopes: string[]): OAuthTokens {
  const t = now();
  return {
    access_token: sign("access", { cid: clientId, sc: scopes, exp: t + ACCESS_TTL_S }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: sign("refresh", { cid: clientId, sc: scopes, exp: t + REFRESH_TTL_S }),
    ...(scopes.length ? { scope: scopes.join(" ") } : {}),
  };
}

// Codes are single-use. This server keeps its snapshot in memory and runs as one process,
// so remembering spent codes in memory until they expire is enough.
const spentCodes = new Map<string, number>();
function spendCode(jti: string, exp: number): boolean {
  const t = now();
  for (const [id, e] of spentCodes) if (e < t) spentCodes.delete(id);
  if (spentCodes.has(jti)) return false;
  spentCodes.set(jti, exp);
  return true;
}

function checkResource(resource?: URL) {
  // A client may name the MCP endpoint or the server root; anything on another origin is not ours.
  if (resource && resource.origin !== config.publicUrl.origin) {
    throw new InvalidTargetError(`This server only issues tokens for ${mcpUrl.href}`);
  }
}

type CodePayload = { cid: string; ru: string; cc: string; sc: string[]; jti: string; exp: number };

export const provider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    checkResource(params.resource);
    const request = sign("login", {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      exp: now() + LOGIN_FORM_TTL_S,
    });
    renderLogin(res, request, client, params.redirectUri);
  },

  async challengeForAuthorizationCode(client, code) {
    const p = verify<CodePayload>("code", code);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return p.cc;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    checkResource(resource);
    const p = verify<CodePayload>("code", code);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== p.ru) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (!spendCode(p.jti, p.exp)) throw new InvalidGrantError("Authorization code already used");
    return issueTokens(client.client_id, p.sc);
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    checkResource(resource);
    const p = verify<{ cid: string; sc: string[] }>("refresh", refreshToken);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    const granted = scopes?.length ? scopes.filter((s) => p.sc.includes(s)) : p.sc;
    return issueTokens(client.client_id, granted);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (safeEqual(token, config.authToken)) {
      return { token, clientId: "static-token", scopes: [], expiresAt: now() + ACCESS_TTL_S, resource: mcpUrl };
    }
    const p = verify<{ cid: string; sc: string[]; exp: number }>("access", token);
    if (!p) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: p.cid, scopes: p.sc, expiresAt: p.exp, resource: mcpUrl };
  },
};

// ---- login page ----

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function renderLogin(
  res: Response,
  request: string,
  client: Pick<OAuthClientInformationFull, "client_name">,
  redirectUri: string,
  error?: string,
  status = error ? 401 : 200,
) {
  let target = redirectUri;
  try {
    const u = new URL(redirectUri);
    target = u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    /* shown as given */
  }
  const name = client.client_name ? escapeHtml(client.client_name) : "An MCP client";
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    })
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #111; --muted: #666; --border: #d0d4da; --accent: #2b59c3; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1b1e24; --fg: #eee; --muted: #a0a4ab; --border: #33373f; --accent: #6d94ef; --error: #f97066; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { box-sizing: border-box; width: min(420px, calc(100% - 32px)); background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  code { color: var(--fg); word-break: break-all; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: var(--error); margin-bottom: 12px; }
</style>
</head>
<body>
<main>
  <h1>Authorize read-only Turnkey access</h1>
  <p><strong>${name}</strong> wants to read this server's Turnkey usage data. After you approve, you will be sent to <code>${escapeHtml(target)}</code>.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="${LOGIN_PATH}">
    <input type="hidden" name="request" value="${escapeHtml(request)}">
    <label for="password">Access token</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Approve</button>
  </form>
</main>
</body>
</html>`);
}

// Failed logins per IP. MCP_AUTH_TOKEN is too long to guess; this only stops a client from
// hammering the form.
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_S = 15 * 60;

function tooManyFailures(ip: string): boolean {
  const f = failures.get(ip);
  return Boolean(f && f.resetAt > now() && f.count >= MAX_FAILURES);
}
function recordFailure(ip: string) {
  const t = now();
  for (const [k, v] of failures) if (v.resetAt < t) failures.delete(k);
  const f = failures.get(ip);
  if (f && f.resetAt > t) f.count++;
  else failures.set(ip, { count: 1, resetAt: t + FAILURE_WINDOW_S });
}

export const loginRouter = express.Router();
loginRouter.post(LOGIN_PATH, express.urlencoded({ extended: false, limit: "16kb" }), async (req: Request, res: Response) => {
  const request = typeof req.body?.request === "string" ? req.body.request : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const p = verify<{ cid: string; ru: string; cc: string; st?: string; sc: string[] }>("login", request);
  const client = p ? await clientsStore.getClient(p.cid) : undefined;
  if (!p || !client) {
    res.status(400).type("text/plain").send("This sign-in link expired. Start the connection again from your MCP client.");
    return;
  }
  const ip = req.ip ?? "unknown";
  if (tooManyFailures(ip)) {
    renderLogin(res, request, client, p.ru, "Too many failed attempts. Try again in 15 minutes.", 429);
    return;
  }
  if (!safeEqual(password, config.authToken)) {
    recordFailure(ip);
    renderLogin(res, request, client, p.ru, "That access token is not valid.");
    return;
  }
  const code = sign("code", { cid: p.cid, ru: p.ru, cc: p.cc, sc: p.sc, jti: crypto.randomUUID(), exp: now() + CODE_TTL_S });
  const target = new URL(p.ru);
  target.searchParams.set("code", code);
  if (p.st) target.searchParams.set("state", p.st);
  res.redirect(302, target.href);
});
