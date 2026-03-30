import { createProxyMiddleware } from "http-proxy-middleware";
import { getMappings, getDefaultBackend } from "../config/proxyConfig.js";
import logger from "../utils/logger.js";

/** Extract the app name segment from a path like /tracker/foo → "tracker" */
function extractAppName(reqPath) {
  const match = reqPath.match(/^\/([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

export function resolveBackend(req) {
  const reqPath = req.url || "/";
  const appName = extractAppName(reqPath);

  if (appName) {
    for (const m of getMappings()) {
      if (m.name === appName) return m.backend;
    }
  }

  return getDefaultBackend();
}

export function createApiProxy() {
  const proxy = createProxyMiddleware({
    changeOrigin: true,
    ws: true,
    xfwd: true,
    selfHandleResponse: false,
    pathRewrite: (reqPath) => reqPath.replace(/^\/[a-z0-9_-]+/i, ""),

    timeout: 30_000,
    proxyTimeout: 30_000,

    router: (req) => resolveBackend(req),

    onProxyReq: (proxyReq, req) => {
      // Strip any client-provided user headers to prevent spoofing
      proxyReq.removeHeader("x-user-email");
      proxyReq.removeHeader("x-user-sub");
      proxyReq.removeHeader("x-user-name");

      // Inject from authenticated session (set by requireAuth)
      const user = req.auth?.tokenSet?.user;
      if (user) {
        if (user.email) proxyReq.setHeader("x-user-email", user.email);
        if (user.sub) proxyReq.setHeader("x-user-sub", user.sub);
        if (user.name) proxyReq.setHeader("x-user-name", user.name);
      }
    },

    onError: (err, req, res) => {
      logger.error({ err, url: req.originalUrl }, "Proxy error");
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "bad_gateway", message: err?.message || "proxy error" }));
    },
  });

  return proxy;
}
