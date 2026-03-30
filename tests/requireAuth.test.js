import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../src/config/index.js", () => ({
  default: {
    cookie: { name: "sid" },
    refreshSkewSeconds: 60,
  },
}));

const mockGetSession = vi.fn();
const mockSetSession = vi.fn();
vi.mock("../src/services/sessionStore.js", () => ({
  getSession: (...args) => mockGetSession(...args),
  setSession: (...args) => mockSetSession(...args),
}));

const mockRefreshTokens = vi.fn();
vi.mock("../src/services/oidc.js", () => ({
  refreshTokens: (...args) => mockRefreshTokens(...args),
}));

const { default: requireAuth } = await import("../src/middleware/requireAuth.js");

function makeReq(cookies = {}, method = "GET") {
  return { cookies, method };
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

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSession.mockResolvedValue(undefined);
  });

  it("skips auth for OPTIONS requests", async () => {
    const next = vi.fn();
    await requireAuth(makeReq({}, "OPTIONS"), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns 401 when no session cookie", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(makeReq({}), res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when session has no access_token", async () => {
    mockGetSession.mockResolvedValueOnce({ refresh_token: "rt" });
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(makeReq({ sid: "s1" }), res, next);

    expect(res._status).toBe(401);
  });

  it("sets req.auth and calls next for valid session", async () => {
    const sess = {
      access_token: "at",
      access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { email: "a@b.com", sub: "u1", name: "A" },
    };
    mockGetSession.mockResolvedValueOnce(sess);

    const req = makeReq({ sid: "s1" });
    const next = vi.fn();
    await requireAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth.sid).toBe("s1");
    expect(req.auth.tokenSet).toBe(sess);
  });

  describe("token refresh preserves user (#1, #5)", () => {
    it("refreshes near-expiry token and preserves user in session", async () => {
      const sess = {
        access_token: "old_at",
        refresh_token: "rt",
        access_expires_at: Math.floor(Date.now() / 1000) + 10, // expires in 10s, within 60s skew
        user: { email: "a@b.com", sub: "u1", name: "Alice" },
      };
      mockGetSession.mockResolvedValueOnce(sess);

      const refreshed = {
        access_token: "new_at",
        refresh_token: "new_rt",
        expires_in: 3600,
      };
      mockRefreshTokens.mockResolvedValueOnce(refreshed);

      const req = makeReq({ sid: "s1" });
      const next = vi.fn();
      await requireAuth(req, makeRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(mockRefreshTokens).toHaveBeenCalledWith("rt");

      // setSession should be called with merged data including user
      const setCall = mockSetSession.mock.calls[0];
      expect(setCall[0]).toBe("s1");
      const savedData = setCall[1];
      expect(savedData.access_token).toBe("new_at");
      expect(savedData.user).toEqual({ email: "a@b.com", sub: "u1", name: "Alice" });

      // req.auth should have updated tokens + user
      expect(req.auth.tokenSet.access_token).toBe("new_at");
      expect(req.auth.tokenSet.user).toEqual({ email: "a@b.com", sub: "u1", name: "Alice" });
    });

    it("returns 401 when refresh fails", async () => {
      const sess = {
        access_token: "old",
        refresh_token: "rt",
        access_expires_at: Math.floor(Date.now() / 1000) + 5,
      };
      mockGetSession.mockResolvedValueOnce(sess);
      mockRefreshTokens.mockRejectedValueOnce(new Error("refresh failed"));

      const res = makeRes();
      const next = vi.fn();
      await requireAuth(makeReq({ sid: "s1" }), res, next);

      expect(res._status).toBe(401);
      expect(res._json.error).toBe("Session expired");
      expect(next).not.toHaveBeenCalled();
    });
  });
});
