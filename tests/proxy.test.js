import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyConfig before importing proxy.js
const mockMappings = [
  { name: "authentic-tracker", backend: "http://backend-a:3000" },
  { name: "vocabuildary", backend: "http://backend-b:3000" },
];

vi.mock("../src/config/proxyConfig.js", () => ({
  getMappings: () => mockMappings,
  getDefaultBackend: () => "http://fallback:9999",
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

  describe("router — app-name path matching", () => {
    function route(url) {
      return capturedOptions.router({ headers: { host: "gateway.example.com" }, url, originalUrl: `/api${url}` });
    }

    it("matches the first path segment to a backend", () => {
      expect(route("/authentic-tracker/foo")).toBe("http://backend-a:3000");
    });

    it("matches case-insensitively", () => {
      expect(route("/Vocabuildary/words")).toBe("http://backend-b:3000");
    });

    it("returns defaultBackend when no mapping matches", () => {
      expect(route("/unknown/path")).toBe("http://fallback:9999");
    });
  });

  describe("pathRewrite", () => {
    it("strips the mapped app-name prefix", () => {
      expect(capturedOptions.pathRewrite("/authentic-tracker/foo/bar")).toBe("/foo/bar");
    });

    it("leaves the backend root when only the app-name is present", () => {
      expect(capturedOptions.pathRewrite("/authentic-tracker")).toBe("");
      expect(capturedOptions.pathRewrite("/authentic-tracker/")).toBe("/");
    });
  });

  describe("on.proxyReq — header spoofing prevention (#10)", () => {
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

      capturedOptions.on.proxyReq(proxyReq, req, {});

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

      capturedOptions.on.proxyReq(proxyReq, { auth: null }, {});

      expect(removed).toContain("x-user-email");
      expect(removed).toContain("x-user-sub");
      expect(removed).toContain("x-user-name");
      // Should not set any headers
      expect(Object.keys(set)).toHaveLength(0);
    });

    it("uses http-proxy-middleware v3 event hooks", () => {
      expect(capturedOptions.on).toEqual(
        expect.objectContaining({
          error: expect.any(Function),
          proxyReq: expect.any(Function),
          proxyReqWs: expect.any(Function),
        })
      );
      expect(capturedOptions.onProxyReq).toBeUndefined();
      expect(capturedOptions.onError).toBeUndefined();
    });
  });
});
