import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

vi.mock("../src/config/index.js", () => ({
  default: {
    baseUrl: "https://api-get-away.krishnarajthadesar.in",
    cookie: { name: "sid" },
  },
}));

const mockRequireAuth = vi.fn((req, _res, next) => {
  req.auth = { sid: "sid-1", tokenSet: { access_token: "at" } };
  next();
});
const mockApiProxy = vi.fn((req, res) => {
  res.status(200).json({ proxied: true, url: req.url, auth: req.auth || null });
});
const mockGetSession = vi.fn();

vi.mock("../src/middleware/requireAuth.js", () => ({
  default: (...args) => mockRequireAuth(...args),
}));

vi.mock("../src/services/sessionStore.js", () => ({
  getSession: (...args) => mockGetSession(...args),
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
          redirect: "manual",
        });
        const body = await res.text();
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        resolve({
          status: res.status,
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

describe("proxy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
  });

  it("redirects unauthenticated mobile auth start requests into gateway login", async () => {
    const app = buildApp();
    const res = await request(
      app,
      "GET",
      "/api/vocabuildary/mobile/auth/start?redirect_uri=com.kptgames.vocabuildary%3A%2F%2Fauth"
    );

    expect(res.status).toBe(302);
    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(mockApiProxy).not.toHaveBeenCalled();
    expect(
      new URL(res.location).pathname + new URL(res.location).search
    ).toBe(
      "/auth/login?frontend_host=https%3A%2F%2Fapi-get-away.krishnarajthadesar.in&next=%2Fapi%2Fvocabuildary%2Fmobile%2Fauth%2Fstart%3Fredirect_uri%3Dcom.kptgames.vocabuildary%253A%252F%252Fauth"
    );
  });

  it("lets authenticated mobile auth start requests reach the backend", async () => {
    mockGetSession.mockResolvedValue({ access_token: "at" });

    const app = buildApp();
    const res = await request(
      app,
      "GET",
      "/api/vocabuildary/mobile/auth/start?redirect_uri=com.kptgames.vocabuildary%3A%2F%2Fauth"
    );

    expect(res.status).toBe(200);
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
    expect(res.json.proxied).toBe(true);
    expect(res.json.auth?.sid).toBe("sid-1");
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
