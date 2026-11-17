// HTTP entrypoint: Streamable HTTP MCP transport (stateless), OAuth 2.1 authorization, health check.

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { createServer } from "./server.js";
import { getProgress, getSnapshot, RETRY_AFTER_FAILURE_MINUTES, startScan } from "./scan.js";
import { loginRouter, mcpUrl, provider } from "./oauth.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "Turnkey read-only MCP",
  }),
);
// Clients that look for the metadata at the root instead of the path-specific URL.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({ resource: mcpUrl.href, authorization_servers: [config.publicUrl.href], resource_name: "Turnkey read-only MCP" });
});
app.use(loginRouter);

const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl, expectedResource: mcpUrl });

async function handleMcp(req: Request, res: Response) {
  // Stateless mode: a fresh server + transport per request.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });

app.post("/mcp", auth, express.json({ limit: "1mb" }), handleMcp);
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (_req, res) => {
  const p = getProgress();
  res.json({ ok: true, snapshot: getSnapshot()?.finishedAt ?? null, scan: { running: p.running, phase: p.phase, done: p.done, total: p.total } });
});

// A failed scan leaves the tools without data, so it is retried sooner than the regular interval.
function scheduleScans() {
  startScan()
    .then(
      () => config.scanIntervalMinutes,
      () => RETRY_AFTER_FAILURE_MINUTES,
    )
    .then((minutes) => setTimeout(scheduleScans, minutes * 60_000).unref());
}

app.listen(config.port, () => {
  console.log(`[http] Turnkey read-only MCP listening on :${config.port} (MCP endpoint ${mcpUrl.href})`);
  scheduleScans();
});
