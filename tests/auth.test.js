import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";

// --- Mocks ---

vi.mock("../src/config/index.js", () => ({
  default: {
    cookie: { name: "sid", domain: "example.com", secure: true, sameSite: "none" },
    baseUrl: "https://bff.example.com",
    oidc: {
      issuer: "https://auth.example.com/",
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      userinfoUrl: "https://auth.example.com/userinfo",
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectPath: "/auth/callback",
      scopes: "openid profile email",
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
  mappings: [],
  defaultBackend: "http://fallback:9999",
}));

vi.mock("../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStartAuthFlow = vi.fn(() => ({
  codeVerifier: "cv123",
  codeChallenge: "cc123",
  nonce: "nonce123",
}));
const mockBuildAuthorizeUrl = vi.fn(() => "https://auth.example.com/authorize?mock=1");
const mockExchangeCodeForTokens = vi.fn();
const mockVerifyIdToken = vi.fn();

vi.mock("../src/services/oidc.js", () => ({
  startAuthFlow: (...args) => mockStartAuthFlow(...args),
  buildAuthorizeUrl: (...args) => mockBuildAuthorizeUrl(...args),
  exchangeCodeForTokens: (...args) => mockExchangeCodeForTokens(...args),
  verifyIdToken: (...args) => mockVerifyIdToken(...args),
  revokeToken: vi.fn(),
  fetchUserinfo: vi.fn(),
}));

const mockCreateStateRecord = vi.fn().mockResolvedValue("state-abc");
const mockGetAndDeleteState = vi.fn();
const mockCreateSession = vi.fn().mockResolvedValue("sid-new");
const mockDeleteSession = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/sessionStore.js", () => ({
  createStateRecord: (...args) => mockCreateStateRecord(...args),
  getAndDeleteState: (...args) => mockGetAndDeleteState(...args),
  createSession: (...args) => mockCreateSession(...args),
  deleteSession: (...args) => mockDeleteSession(...args),
  getSession: vi.fn(),
}));

const { default: authRoutes } = await import("../src/routes/auth.js");

// Build a small Express app for testing
function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/auth", authRoutes);
  // error handler so we can see errors
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

// Simple supertest-free request helper using Node's built-in fetch
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
        resolve({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body,
          json,
          location: res.headers.get("location"),
        });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateStateRecord.mockResolvedValue("state-abc");
    mockCreateSession.mockResolvedValue("sid-new");
  });

  describe("GET /auth/login", () => {
    it("redirects to authorize URL for allowed frontend_host", async () => {
      const app = buildApp();
      const res = await request(app, "GET", "/auth/login?frontend_host=https://frontend.example.com&next=/dashboard");

      expect(res.status).toBe(302);
      expect(res.location).toBe("https://auth.example.com/authorize?mock=1");

      // State record should include returnToHost and next
      const statePayload = mockCreateStateRecord.mock.calls[0][0];
      expect(statePayload.returnToHost).toBe("https://frontend.example.com");
      expect(statePayload.next).toBe("/dashboard");
    });

    it("rejects disallowed frontend_host (#8 — open redirect fix)", async () => {
      const app = buildApp();
      const res = await request(app, "GET", "/auth/login?frontend_host=https://evil.com");

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/Disallowed/i);
    });
  });

  describe("GET /auth/callback", () => {
    it("creates session and redirects to frontend on success", async () => {
      mockGetAndDeleteState.mockResolvedValueOnce({
        codeVerifier: "cv",
        nonce: "n1",
        next: "/dash",
        returnToHost: "https://frontend.example.com",
      });
      mockExchangeCodeForTokens.mockResolvedValueOnce({
        access_token: "at",
        id_token: "id_tok",
        refresh_token: "rt",
        expires_in: 3600,
      });
      mockVerifyIdToken.mockResolvedValueOnce({
        sub: "user-1",
        email: "a@b.com",
        name: "Alice",
      });

      const app = buildApp();
      const res = await request(app, "GET", "/auth/callback?state=s1&code=c1");

      expect(res.status).toBe(302);
      expect(res.location).toBe("https://frontend.example.com/dash");

      // Session should be created with user info
      const [tokenArg, userArg] = mockCreateSession.mock.calls[0];
      expect(tokenArg.access_token).toBe("at");
      expect(userArg).toEqual({ email: "a@b.com", sub: "user-1", name: "Alice" });

      // Cookie should be set
      expect(res.headers["set-cookie"]).toContain("sid=sid-new");
    });

    it("returns 502 when id_token is missing (#2 — null crash fix)", async () => {
      mockGetAndDeleteState.mockResolvedValueOnce({
        codeVerifier: "cv",
        nonce: "n1",
        next: "/",
        returnToHost: "https://frontend.example.com",
      });
      mockExchangeCodeForTokens.mockResolvedValueOnce({
        access_token: "at",
        // no id_token
      });

      const app = buildApp();
      const res = await request(app, "GET", "/auth/callback?state=s1&code=c1");

      expect(res.status).toBe(502);
      expect(res.body).toContain("ID token missing");
    });

    it("returns 400 for missing state/code", async () => {
      const app = buildApp();
      const res = await request(app, "GET", "/auth/callback?state=s1");
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid state", async () => {
      mockGetAndDeleteState.mockResolvedValueOnce(null);
      const app = buildApp();
      const res = await request(app, "GET", "/auth/callback?state=bad&code=c1");
      expect(res.status).toBe(400);
    });

    it("falls back to / when returnToHost is missing (#11)", async () => {
      mockGetAndDeleteState.mockResolvedValueOnce({
        codeVerifier: "cv",
        nonce: "n1",
        next: "/x",
        returnToHost: null,
      });
      mockExchangeCodeForTokens.mockResolvedValueOnce({
        access_token: "at",
        id_token: "id",
        expires_in: 3600,
      });
      mockVerifyIdToken.mockResolvedValueOnce({ sub: "u1", email: "x@y.com" });

      const app = buildApp();
      const res = await request(app, "GET", "/auth/callback?state=s&code=c");

      expect(res.status).toBe(302);
      expect(res.location).toBe("/");
    });
  });

  describe("POST /auth/logout", () => {
    it("clears session and cookie", async () => {
      const app = buildApp();
      const res = await request(app, "POST", "/auth/logout", {
        headers: { cookie: "sid=sess-123" },
      });

      expect(res.status).toBe(204);
      expect(mockDeleteSession).toHaveBeenCalledWith("sess-123");
      // Cookie should be cleared (Max-Age=0 or Expires in the past)
      expect(res.headers["set-cookie"]).toBeDefined();
    });

    it("succeeds even without a session cookie", async () => {
      const app = buildApp();
      const res = await request(app, "POST", "/auth/logout");
      expect(res.status).toBe(204);
      expect(mockDeleteSession).not.toHaveBeenCalled();
    });
  });
});
