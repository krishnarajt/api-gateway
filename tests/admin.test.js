import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";

// --- Mocks ---

vi.mock("../src/config/index.js", () => ({
  default: {
    cookie: { name: "sid", domain: "example.com", secure: true, sameSite: "none" },
    refreshSkewSeconds: 60,
    allowedOrigins: [],
  },
}));

const mockGetRawConfig = vi.fn(() => ({
  defaultBackend: "http://fallback:9999",
  allowedOrigins: ["https://frontend.example.com"],
  mappings: [{ frontendHost: "app.example.com", backend: "http://backend:3000" }],
}));
const mockWriteAndReloadConfig = vi.fn();
const mockReloadConfig = vi.fn();

vi.mock("../src/config/proxyConfig.js", () => ({
  getRawConfig: (...args) => mockGetRawConfig(...args),
  writeAndReloadConfig: (...args) => mockWriteAndReloadConfig(...args),
  reloadConfig: (...args) => mockReloadConfig(...args),
  getMappings: () => [],
  getDefaultBackend: () => "http://fallback:9999",
  getAllowedOrigins: () => ["https://frontend.example.com"],
  allowedOrigins: ["https://frontend.example.com"],
  allowedFrontendHosts: ["https://frontend.example.com"],
  mappings: [],
  defaultBackend: "http://fallback:9999",
}));

const mockGetHealthState = vi.fn(() => ({
  "http://backend:3000": { status: "up", lastUp: Date.now(), latencyMs: 42 },
}));
const mockRefreshBackends = vi.fn();

vi.mock("../src/services/healthChecker.js", () => ({
  getHealthState: (...args) => mockGetHealthState(...args),
  refreshBackends: (...args) => mockRefreshBackends(...args),
  startHealthChecker: vi.fn(),
  stopHealthChecker: vi.fn(),
}));

// Mock requireAuth to always pass (inject fake auth)
vi.mock("../src/middleware/requireAuth.js", () => ({
  default: (req, _res, next) => {
    req.auth = { sid: "test-sid", tokenSet: { access_token: "at" } };
    next();
  },
}));

vi.mock("../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: adminRoutes } = await import("../src/routes/admin.js");

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/admin", adminRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function request(app, method, path, opts = {}) {
  const { default: http } = await import("http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        const url = `http://127.0.0.1:${addr.port}${path}`;
        const fetchOpts = { method, redirect: "manual", headers: opts.headers || {} };
        if (opts.body) {
          fetchOpts.body = JSON.stringify(opts.body);
          fetchOpts.headers["content-type"] = "application/json";
        }
        const res = await fetch(url, fetchOpts);
        const body = await res.text();
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.status, json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /admin/config", () => {
    it("returns current config", async () => {
      const app = buildApp();
      const res = await request(app, "GET", "/admin/config");
      expect(res.status).toBe(200);
      expect(res.json.defaultBackend).toBe("http://fallback:9999");
      expect(res.json.mappings).toHaveLength(1);
    });
  });

  describe("PUT /admin/config", () => {
    it("validates and saves config", async () => {
      const app = buildApp();
      const newCfg = {
        defaultBackend: "http://new-fallback:8080",
        allowedOrigins: ["https://new-frontend.example.com"],
        mappings: [{ frontendHost: "new.example.com", backend: "http://new-backend:3000" }],
      };

      mockGetRawConfig.mockReturnValueOnce(newCfg); // after write

      const res = await request(app, "PUT", "/admin/config", { body: newCfg });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(mockWriteAndReloadConfig).toHaveBeenCalledWith(newCfg);
      expect(mockRefreshBackends).toHaveBeenCalled();
    });

    it("rejects config without defaultBackend", async () => {
      const app = buildApp();
      const res = await request(app, "PUT", "/admin/config", {
        body: { mappings: [] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/defaultBackend/);
    });

    it("rejects config with invalid mappings", async () => {
      const app = buildApp();
      const res = await request(app, "PUT", "/admin/config", {
        body: { defaultBackend: "http://x:1", mappings: "not-array" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects mapping without frontendHost", async () => {
      const app = buildApp();
      const res = await request(app, "PUT", "/admin/config", {
        body: {
          defaultBackend: "http://x:1",
          mappings: [{ backend: "http://y:2" }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/frontendHost/);
    });
  });

  describe("POST /admin/config/reload", () => {
    it("reloads config from disk", async () => {
      const app = buildApp();
      const res = await request(app, "POST", "/admin/config/reload");
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(mockReloadConfig).toHaveBeenCalled();
      expect(mockRefreshBackends).toHaveBeenCalled();
    });
  });

  describe("GET /admin/health", () => {
    it("returns health state for all backends", async () => {
      const app = buildApp();
      const res = await request(app, "GET", "/admin/health");
      expect(res.status).toBe(200);
      expect(res.json["http://backend:3000"].status).toBe("up");
      expect(res.json["http://backend:3000"].latencyMs).toBe(42);
    });
  });
});
