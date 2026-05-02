import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies so we can test app-level middleware behavior

vi.mock("../src/config/index.js", () => ({
  default: {
    nodeEnv: "test",
    port: 9999,
    baseUrl: "https://bff.example.com",
    cookie: { name: "sid", domain: "example.com", secure: true, sameSite: "none" },
    redis: { host: "localhost", port: 6379, password: undefined },
    oidc: {
      issuer: "https://auth.example.com/",
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      userinfoUrl: "https://auth.example.com/userinfo",
      clientId: "cid",
      clientSecret: "cs",
      redirectPath: "/auth/callback",
      scopes: "openid",
      idTokenMaxAge: 0,
    },
    refreshSkewSeconds: 60,
    allowedOrigins: [],
  },
}));

vi.mock("../src/config/proxyConfig.js", () => ({
  allowedOrigins: ["https://frontend.example.com"],
  allowedFrontendHosts: ["https://frontend.example.com"],
  getAllowedOrigins: () => ["https://frontend.example.com"],
  getAllowedFrontendHosts: () => ["https://frontend.example.com"],
  getMappings: () => [],
  getDefaultBackend: () => "http://fallback:9999",
  mappings: [],
  defaultBackend: "http://fallback:9999",
}));

vi.mock("../src/utils/logger.js", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: () => logger,
    level: "info",
    levels: { values: { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } },
  };
  return { default: logger };
});

vi.mock("ioredis", () => {
  class MockRedis {
    constructor() {
      this.get = vi.fn().mockResolvedValue(null);
      this.setex = vi.fn().mockResolvedValue("OK");
      this.del = vi.fn().mockResolvedValue(1);
      this.getdel = vi.fn().mockResolvedValue(null);
    }
  }
  return { default: MockRedis };
});

vi.mock("../src/services/oidc.js", () => ({
  startAuthFlow: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  revokeToken: vi.fn(),
  fetchUserinfo: vi.fn(),
}));

vi.mock("../src/utils/crypto.js", () => ({
  randStr: vi.fn(() => "rand"),
  genPkcePair: vi.fn(() => ({ codeVerifier: "cv", codeChallenge: "cc", method: "S256" })),
}));

// Need to mock jose since oidc.js imports it
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
  base64url: { encode: (buf) => Buffer.from(buf).toString("base64url") },
}));

// Need to mock http-proxy-middleware
vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn(() => (req, res, next) => next()),
}));

vi.mock("../src/services/healthChecker.js", () => ({
  getHealthState: vi.fn(() => ({})),
  startHealthChecker: vi.fn(),
  stopHealthChecker: vi.fn(),
  refreshBackends: vi.fn(),
}));

const { default: app } = await import("../src/app.js");

async function request(method, path, opts = {}) {
  const { default: http } = await import("http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        const url = `http://127.0.0.1:${addr.port}${path}`;
        const fetchOpts = { method, redirect: "manual", headers: opts.headers || {} };
        const res = await fetch(url, fetchOpts);
        const body = await res.text();
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body,
          json,
        });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("app-level middleware", () => {
  describe("CORS (#3, #16)", () => {
    it("sets CORS headers for allowed origin", async () => {
      const res = await request("OPTIONS", "/api/test", {
        headers: {
          origin: "https://frontend.example.com",
          "access-control-request-method": "POST",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://frontend.example.com");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("rejects CORS for disallowed origin", async () => {
      const res = await request("OPTIONS", "/api/test", {
        headers: {
          origin: "https://evil.com",
          "access-control-request-method": "POST",
        },
      });

      // cors middleware will error, resulting in 500
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows requests with no Origin (server-to-server)", async () => {
      const res = await request("GET", "/healthz");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    });
  });

  describe("health check", () => {
    it("responds at /healthz", async () => {
      const res = await request("GET", "/healthz");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    });
  });

  describe("404 handler", () => {
    it("returns 404 JSON for unknown routes", async () => {
      const res = await request("GET", "/nonexistent");
      expect(res.status).toBe(404);
      expect(res.json.error).toBe("Not Found");
    });
  });

  describe("security headers", () => {
    it("sets Helmet headers", async () => {
      const res = await request("GET", "/healthz");
      // Helmet sets various headers
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    });
  });
});
