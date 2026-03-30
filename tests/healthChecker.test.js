import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Intercept fetch to simulate backend responses
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// We also need to mock FormData since it's used for notifications
vi.stubGlobal("FormData", class {
  constructor() { this._data = {}; }
  append(k, v) { this._data[k] = v; }
});

const {
  startHealthChecker,
  stopHealthChecker,
  getHealthState,
  refreshBackends,
} = await import("../src/services/healthChecker.js");

describe("healthChecker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopHealthChecker();
  });

  afterEach(() => {
    stopHealthChecker();
    vi.useRealTimers();
  });

  it("initializes state for all backends", () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true });

    const mappings = [
      { backend: "http://a:3000" },
      { backend: "http://b:4000" },
    ];
    startHealthChecker(mappings, "http://fallback:9999");

    const state = getHealthState();
    expect(Object.keys(state)).toHaveLength(3); // a, b, fallback
    expect(state["http://a:3000"]).toBeDefined();
    expect(state["http://b:4000"]).toBeDefined();
    expect(state["http://fallback:9999"]).toBeDefined();
  });

  it("marks backends as up after successful check", async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true });

    startHealthChecker([], "http://backend:3000");

    // Let the immediate checkAll() resolve
    await vi.runOnlyPendingTimersAsync();

    const state = getHealthState();
    expect(state["http://backend:3000"].status).toBe("up");
    expect(state["http://backend:3000"].latencyMs).toBeGreaterThanOrEqual(0);
    expect(state["http://backend:3000"].lastCheck).toBeDefined();
  });

  it("marks backends as down when fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    startHealthChecker([], "http://dead:3000");
    await vi.runOnlyPendingTimersAsync();

    const state = getHealthState();
    expect(state["http://dead:3000"].status).toBe("down");
    expect(state["http://dead:3000"].firstDownAt).toBeDefined();
    expect(state["http://dead:3000"].latencyMs).toBeNull();
  });

  it("marks backends as down when status >= 400", async () => {
    fetchMock.mockResolvedValue({ status: 503, ok: false });

    startHealthChecker([], "http://sick:3000");
    await vi.runOnlyPendingTimersAsync();

    const state = getHealthState();
    expect(state["http://sick:3000"].status).toBe("down");
  });

  it("refreshBackends adds new and removes stale backends", async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true });

    startHealthChecker([{ backend: "http://old:3000" }], "http://fb:9999");
    await vi.runOnlyPendingTimersAsync();

    // Refresh with different backends
    refreshBackends([{ backend: "http://new:5000" }], "http://fb:9999");

    const state = getHealthState();
    expect(state["http://new:5000"]).toBeDefined();
    expect(state["http://fb:9999"]).toBeDefined();
    expect(state["http://old:3000"]).toBeUndefined(); // removed
  });

  it("sends notification after 6 hours of downtime", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    startHealthChecker([], "http://flaky:3000");
    await vi.runOnlyPendingTimersAsync();

    let state = getHealthState();
    expect(state["http://flaky:3000"].notifiedDown).toBe(false);

    // Advance 6 hours + 1 minute
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 60_000);
    await vi.runOnlyPendingTimersAsync();

    state = getHealthState();
    expect(state["http://flaky:3000"].notifiedDown).toBe(true);

    // One of the fetch calls should be the notification POST
    const notifyCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("notify")
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sends recovery notification when backend comes back after notified downtime", async () => {
    // Start down
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    startHealthChecker([], "http://recovering:3000");
    await vi.runOnlyPendingTimersAsync();

    // Advance past 6h threshold
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 60_000);
    await vi.runOnlyPendingTimersAsync();

    expect(getHealthState()["http://recovering:3000"].notifiedDown).toBe(true);

    // Now it comes back up
    fetchMock.mockResolvedValue({ status: 200, ok: true });
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    const state = getHealthState();
    expect(state["http://recovering:3000"].status).toBe("up");
    expect(state["http://recovering:3000"].notifiedDown).toBe(false);

    // Should have sent a recovery notification
    const notifyCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("notify")
    );
    // At least 2: one for down, one for recovery
    expect(notifyCalls.length).toBeGreaterThanOrEqual(2);
  });
});
