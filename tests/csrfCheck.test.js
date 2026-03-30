import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to control config.allowedOrigins per test
let mockAllowedOrigins = [];

vi.mock("../src/config/index.js", () => ({
  default: {
    get allowedOrigins() { return mockAllowedOrigins; },
  },
}));

const { default: csrfCheck } = await import("../src/middleware/csrfCheck.js");

function makeReq(method, headers = {}) {
  return {
    method,
    headers,
    protocol: "https",
    get: (key) => {
      if (key === "host") return headers.host || "api.example.com";
      return headers[key.toLowerCase()];
    },
  };
}
function makeRes() {
  const res = {
    _status: null,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

describe("csrfCheck", () => {
  beforeEach(() => {
    mockAllowedOrigins = [];
  });

  it("allows safe methods (GET, HEAD, OPTIONS) unconditionally", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "TRACE"]) {
      const next = vi.fn();
      csrfCheck(makeReq(method), makeRes(), next);
      expect(next).toHaveBeenCalled();
    }
  });

  describe("with allowedOrigins configured", () => {
    beforeEach(() => {
      mockAllowedOrigins = ["https://frontend.example.com"];
    });

    it("allows POST when Origin matches", () => {
      const next = vi.fn();
      csrfCheck(
        makeReq("POST", { origin: "https://frontend.example.com" }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalled();
    });

    it("allows POST when Referer starts with allowed origin", () => {
      const next = vi.fn();
      csrfCheck(
        makeReq("POST", { referer: "https://frontend.example.com/page" }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalled();
    });

    it("rejects POST from disallowed origin", () => {
      const res = makeRes();
      const next = vi.fn();
      csrfCheck(
        makeReq("POST", { origin: "https://evil.com" }),
        res,
        next
      );
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe("without allowedOrigins (same-origin fallback)", () => {
    it("allows POST when Origin matches Host", () => {
      const next = vi.fn();
      csrfCheck(
        makeReq("POST", { origin: "https://api.example.com", host: "api.example.com" }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalled();
    });

    it("rejects POST when Origin differs from Host", () => {
      const res = makeRes();
      const next = vi.fn();
      csrfCheck(
        makeReq("POST", { origin: "https://evil.com", host: "api.example.com" }),
        res,
        next
      );
      expect(res._status).toBe(403);
    });

    it("allows POST with no Origin or Referer (non-browser clients)", () => {
      const next = vi.fn();
      csrfCheck(makeReq("POST", { host: "api.example.com" }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });
});
