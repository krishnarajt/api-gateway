import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const mockRequireAuth = vi.fn((req, _res, next) => {
  req.auth = { sid: "sid-1", tokenSet: { access_token: "at" } };
  next();
});
const mockApiProxy = vi.fn((req, res) => {
  res.status(200).json({ proxied: true, url: req.url, auth: req.auth || null });
});

vi.mock("../src/middleware/requireAuth.js", () => ({
  default: (...args) => mockRequireAuth(...args),
}));

vi.mock("../src/services/proxy.js", () => ({
  createApiProxy: () => (...args) => mockApiProxy(...args),
}));

const { default: proxyRoutes } = await import("../src/routes/proxy_routes.js");

function buildApp() {
  const app = express();
  app.use("/api", proxyRoutes);
  return app;
}

async function request(app, method, path) {
  const { default: http } = await import("http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
        });
        resolve({
          status: res.status,
          json: await res.json(),
        });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("proxy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows mobile auth start requests through without session auth", async () => {
    const app = buildApp();
    const res = await request(
      app,
      "GET",
      "/api/vocabuildary/mobile/auth/start?redirect_uri=com.kptgames.vocabuildary%3A%2F%2Fauth"
    );

    expect(res.status).toBe(200);
    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(res.json.proxied).toBe(true);
    expect(res.json.auth).toBeNull();
  });

  it("still requires auth for other proxied api routes", async () => {
    const app = buildApp();
    const res = await request(app, "GET", "/api/vocabuildary/words");

    expect(res.status).toBe(200);
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
    expect(res.json.proxied).toBe(true);
    expect(res.json.auth?.sid).toBe("sid-1");
  });
});
