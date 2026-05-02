import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ioredis before importing sessionStore
const mockRedis = {
  setex: vi.fn().mockResolvedValue("OK"),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  getdel: vi.fn().mockResolvedValue(null),
};

class MockRedis {
  constructor() {
    Object.assign(this, mockRedis);
  }
}

vi.mock("ioredis", () => ({
  default: MockRedis,
}));

// Mock config
vi.mock("../src/config/index.js", () => ({
  default: { redis: { host: "localhost", port: 6379, password: undefined } },
}));

// Mock crypto util
vi.mock("../src/utils/crypto.js", () => ({
  randStr: vi.fn(() => "test-random-id-123"),
}));

const {
  createSession,
  getSession,
  setSession,
  deleteSession,
  createStateRecord,
  getAndDeleteState,
} = await import("../src/services/sessionStore.js");

describe("sessionStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("stores token set with user info in Redis", async () => {
      const tokenSet = {
        access_token: "at_123",
        refresh_token: "rt_456",
        expires_in: 3600,
        id_token: "id_tok",
      };
      const userInfo = { email: "a@b.com", sub: "user-1", name: "Alice" };

      const sid = await createSession(tokenSet, userInfo);

      expect(sid).toBe("test-random-id-123");
      expect(mockRedis.setex).toHaveBeenCalledOnce();

      const [key, ttl, json] = mockRedis.setex.mock.calls[0];
      expect(key).toBe("session:test-random-id-123");
      expect(ttl).toBe(60 * 60 * 8);

      const stored = JSON.parse(json);
      expect(stored.access_token).toBe("at_123");
      expect(stored.refresh_token).toBe("rt_456");
      expect(stored.user).toEqual(userInfo);
      expect(stored.access_expires_at).toBeGreaterThan(0);
    });

    it("computes access_expires_at from expires_in", async () => {
      const now = Math.floor(Date.now() / 1000);
      await createSession({ access_token: "x", expires_in: 1800 });

      const stored = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      // Should be approximately now + 1800 (within 2 seconds tolerance)
      expect(stored.access_expires_at).toBeGreaterThanOrEqual(now + 1798);
      expect(stored.access_expires_at).toBeLessThanOrEqual(now + 1802);
    });
  });

  describe("setSession — preserves user through token refresh (#1, #5)", () => {
    it("keeps user field when present in tokenSet", async () => {
      const refreshedData = {
        access_token: "new_at",
        refresh_token: "new_rt",
        expires_in: 3600,
        user: { email: "a@b.com", sub: "user-1", name: "Alice" },
      };

      await setSession("sid-abc", refreshedData);

      const stored = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(stored.user).toEqual({ email: "a@b.com", sub: "user-1", name: "Alice" });
      expect(stored.access_token).toBe("new_at");
    });

    it("does not add user field when absent", async () => {
      await setSession("sid-abc", { access_token: "at", expires_in: 3600 });

      const stored = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(stored.user).toBeUndefined();
    });
  });

  describe("getSession", () => {
    it("returns parsed session data", async () => {
      const sess = { access_token: "at", user: { email: "x@y.com" } };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(sess));

      const result = await getSession("sid-1");
      expect(result).toEqual(sess);
      expect(mockRedis.get).toHaveBeenCalledWith("session:sid-1");
    });

    it("returns null for missing session", async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      expect(await getSession("no-such")).toBeNull();
    });

    it("returns null when sid is falsy", async () => {
      expect(await getSession(null)).toBeNull();
      expect(await getSession(undefined)).toBeNull();
      expect(await getSession("")).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("deletes the key from Redis", async () => {
      await deleteSession("sid-x");
      expect(mockRedis.del).toHaveBeenCalledWith("session:sid-x");
    });
  });

  describe("createStateRecord", () => {
    it("stores state with 10min TTL", async () => {
      const payload = { codeVerifier: "cv", nonce: "n1" };
      const state = await createStateRecord(payload);

      expect(state).toBe("test-random-id-123");
      const [key, ttl, json] = mockRedis.setex.mock.calls[0];
      expect(key).toBe("state:test-random-id-123");
      expect(ttl).toBe(600);
      expect(JSON.parse(json)).toEqual(payload);
    });
  });

  describe("getAndDeleteState — atomic GETDEL (#7)", () => {
    it("returns and deletes state atomically", async () => {
      const record = { codeVerifier: "cv", nonce: "n1" };
      mockRedis.getdel.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getAndDeleteState("state-abc");
      expect(result).toEqual(record);
      expect(mockRedis.getdel).toHaveBeenCalledWith("state:state-abc");
      // Should NOT call separate get+del
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it("returns null for missing state", async () => {
      mockRedis.getdel.mockResolvedValueOnce(null);
      expect(await getAndDeleteState("nope")).toBeNull();
    });
  });
});
