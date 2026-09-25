#!/usr/bin/env node

import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createProxyApp } from "./proxy.js";

const config = (() => {
  try {
    return loadConfig(process.env);
  } catch (err) {
    console.error("[proxy] ✖ invalid configuration:", err);
    process.exit(1);
  }
})();

let app: ReturnType<typeof createProxyApp>["app"];
let cache: ReturnType<typeof createProxyApp>["cache"];
try {
  ({ app, cache } = createProxyApp(config));
} catch (err) {
  console.error("[proxy] ✖ failed to build proxy app:", err);
  process.exit(1);
}

// http.createServer + error listener BEFORE listen() so a bind failure
// (EADDRINUSE) surfaces as a clean message, not an uncaught async throw.
const server = createServer(app);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[proxy] ✖ port ${config.port} on ${config.host} is already in use. Set PORT to something else or stop the other process.`,
    );
  } else {
    console.error("[proxy] ✖ server error:", err);
  }
  cache.dispose();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log("");
  console.log("  gemini-thought-signature-proxy v2");
  console.log(`  listening    → http://${config.host}:${config.port}`);
  console.log(`  forwarding   → ${config.upstreamBaseUrl}`);
  console.log(`  model filter → ${config.modelFilterDescription}`);
  console.log(`  cache        → ${config.cacheMaxEntries} entries, ${Math.round(config.cacheTtlMs / 1000)}s TTL`);
  console.log("");
});

let isShuttingDown = false;
let forceExit = false;
function shutdown(signal: string): void {
  // Second signal: active SSE streams would otherwise pin us for the whole
  // grace period — get out now.
  if (isShuttingDown) {
    if (!forceExit) {
      forceExit = true;
      console.error("[proxy] second signal, forcing exit");
      cache?.dispose();
      process.exit(1);
    }
    return;
  }
  isShuttingDown = true;
  console.log(`[proxy] ${signal} received, shutting down…`);

  const forceTimer = setTimeout(() => {
    console.error("[proxy] forced shutdown: connections did not close in time");
    cache?.dispose();
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  // Node ≥18.2: drop keep-alive sockets so close() can actually finish.
  server.closeIdleConnections?.();

  // In-flight requests may still touch the cache — dispose AFTER close().
  server.close((err?: Error) => {
    clearTimeout(forceTimer);
    cache?.dispose();
    if (err) {
      console.error("[proxy] error during shutdown:", err);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error("[proxy] ✖ uncaught exception:", err);
  cache.dispose();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[proxy] ✖ unhandled rejection:", reason);
  cache.dispose();
  process.exit(1);
});
