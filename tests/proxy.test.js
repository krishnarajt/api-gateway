import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyConfig before importing proxy.js
vi.mock("../src/config/proxyConfig.js", () => ({
  mappings: [
    { frontendHost: "app.example.com", frontendPort: null, pathPrefix: null, backend: "http://backend-a:3000" },
    { frontendHost: "app.example.com", frontendPort: null, pathPrefix: "/v2", backend: "http://backend-b:3000" },
    { frontendHost: "multi.example.com", frontendPort: 8080, pathPrefix: null, backend: "http://backend-c:3000" },
    { frontendHost: "multi.example.com", frontendPort: null, pathPrefix: null, backend: "http://backend-d:3000" },
  ],
  defaultBackend: "http://fallback:9999",
}));

vi.mock("../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the options passed to createProxyMiddleware
let capturedOptions;
vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn((opts) => {
    capturedOptions = opts;
    return (req, res, next) => next();
  }),
}));

const { createApiProxy } = await import("../src/services/proxy.js");

describe("proxy", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    createApiProxy();
  });

  describe("router — host matching", () => {
    function route(host, url) {
      return capturedOptions.router({ headers: { host }, url, originalUrl: `/api${url}` });
    }

    it("matches exact host to backend", () => {
      expect(route("app.example.com", "/foo")).toBe("http://backend-a:3000");
    });

    it("matches host + pathPrefix", () => {
      expect(route("app.example.com", "/v2/things")).toBe("http://backend-b:3000");
    });

    it("prefers pathPrefix match over general host match", () => {
      expect(route("app.example.com", "/v2/stuff")).toBe("http://backend-b:3000");
    });

    it("falls back to non-prefix mapping when path doesn't match prefix", () => {
      expect(route("app.example.com", "/other")).toBe("http://backend-a:3000");
    });

    it("matches host + port when frontendPort is configured", () => {
      expect(route("multi.example.com:8080", "/x")).toBe("http://backend-c:3000");
    });

    it("falls back to port-less mapping when port doesn't match", () => {
      expect(route("multi.example.com:9999", "/x")).toBe("http://backend-d:3000");
    });

    it("returns defaultBackend when no mapping matches", () => {
      expect(route("unknown.com", "/")).toBe("http://fallback:9999");
    });
  });

  describe("pathRewrite (#12)", () => {
    it("strips /api prefix", () => {
      expect(capturedOptions.pathRewrite("/api/foo/bar")).toBe("/foo/bar");
    });

    it("only strips leading /api", () => {
      expect(capturedOptions.pathRewrite("/api")).toBe("");
      expect(capturedOptions.pathRewrite("/api/")).toBe("/");
    });
  });

  describe("router uses req.url not req.originalUrl (#12)", () => {
    it("pathPrefix matches against mount-relative path", () => {
      // req.url = "/v2/things" (mount-relative), req.originalUrl = "/api/v2/things"
      const backend = capturedOptions.router({
        headers: { host: "app.example.com" },
        url: "/v2/things",
        originalUrl: "/api/v2/things",
      });
      expect(backend).toBe("http://backend-b:3000");
    });
  });

  describe("onProxyReq — header spoofing prevention (#10)", () => {
    it("strips client x-user-* headers and injects from session", () => {
      const removed = [];
      const set = {};
      const proxyReq = {
        removeHeader: (h) => removed.push(h),
        setHeader: (k, v) => { set[k] = v; },
      };
      const req = {
        auth: {
          tokenSet: {
            user: { email: "real@user.com", sub: "u1", name: "Real" },
          },
        },
      };

      capturedOptions.onProxyReq(proxyReq, req, {});

      expect(removed).toContain("x-user-email");
      expect(removed).toContain("x-user-sub");
      expect(removed).toContain("x-user-name");
      expect(set["x-user-email"]).toBe("real@user.com");
      expect(set["x-user-sub"]).toBe("u1");
      expect(set["x-user-name"]).toBe("Real");
    });

    it("strips headers even when no session exists", () => {
      const removed = [];
      const set = {};
      const proxyReq = {
        removeHeader: (h) => removed.push(h),
        setHeader: (k, v) => { set[k] = v; },
      };

      capturedOptions.onProxyReq(proxyReq, { auth: null }, {});

      expect(removed).toContain("x-user-email");
      expect(removed).toContain("x-user-sub");
      expect(removed).toContain("x-user-name");
      // Should not set any headers
      expect(Object.keys(set)).toHaveLength(0);
    });
  });
});
