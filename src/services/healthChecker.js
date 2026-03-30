import logger from "../utils/logger.js";

const HEALTH_CHECK_INTERVAL = 60_000;       // check every 60s
const NOTIFY_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours
const NOTIFY_URL = "https://notify.krishnarajthadesar.in/notify/apprise";

// State per backend URL
// { url: { status: "up"|"down"|"unknown", lastUp: number, firstDownAt: number|null, notifiedDown: boolean, lastCheck: number, latencyMs: number|null } }
const state = new Map();

let mappingsRef = [];
let defaultBackendRef = null;
let intervalId = null;

export function getHealthState() {
  const result = {};
  for (const [url, s] of state) {
    result[url] = { ...s };
  }
  return result;
}

export function startHealthChecker(mappings, defaultBackend) {
  mappingsRef = mappings;
  defaultBackendRef = defaultBackend;

  // Build initial state for all known backends
  const urls = new Set();
  if (defaultBackend) urls.add(defaultBackend);
  for (const m of mappings) {
    if (m.backend) urls.add(m.backend);
  }

  for (const url of urls) {
    if (!state.has(url)) {
      state.set(url, {
        status: "unknown",
        lastUp: null,
        firstDownAt: null,
        notifiedDown: false,
        lastCheck: null,
        latencyMs: null,
      });
    }
  }

  // Run immediately, then on interval
  checkAll();
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(checkAll, HEALTH_CHECK_INTERVAL);
  logger.info({ backends: [...urls] }, "Health checker started");
}

export function stopHealthChecker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

// Re-sync when config changes (add new backends, remove stale ones)
export function refreshBackends(mappings, defaultBackend) {
  mappingsRef = mappings;
  defaultBackendRef = defaultBackend;

  const urls = new Set();
  if (defaultBackend) urls.add(defaultBackend);
  for (const m of mappings) {
    if (m.backend) urls.add(m.backend);
  }

  // Add new
  for (const url of urls) {
    if (!state.has(url)) {
      state.set(url, {
        status: "unknown",
        lastUp: null,
        firstDownAt: null,
        notifiedDown: false,
        lastCheck: null,
        latencyMs: null,
      });
    }
  }

  // Remove backends no longer in config
  for (const url of state.keys()) {
    if (!urls.has(url)) state.delete(url);
  }
}

async function checkAll() {
  const promises = [];
  for (const [url] of state) {
    promises.push(checkOne(url));
  }
  await Promise.allSettled(promises);
}

async function checkOne(url) {
  const s = state.get(url);
  if (!s) return;

  const start = Date.now();
  let up = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    // Accept any 2xx/3xx as healthy
    up = res.status < 400;
  } catch {
    up = false;
  }

  const now = Date.now();
  s.lastCheck = now;
  s.latencyMs = up ? now - start : null;

  if (up) {
    const wasDown = s.status === "down";
    const wasNotified = s.notifiedDown;

    s.status = "up";
    s.lastUp = now;
    s.firstDownAt = null;
    s.notifiedDown = false;

    if (wasDown && wasNotified) {
      // Backend recovered after we had notified about downtime
      await sendNotification(
        `Backend RECOVERED: ${url} is back up.`
      );
      logger.info({ url }, "Backend recovered");
    }
  } else {
    if (s.status !== "down") {
      s.firstDownAt = now;
    }
    s.status = "down";

    // Notify if down for more than 6 hours and not yet notified
    if (s.firstDownAt && now - s.firstDownAt >= NOTIFY_AFTER_MS && !s.notifiedDown) {
      s.notifiedDown = true;
      const hours = Math.round((now - s.firstDownAt) / 3_600_000);
      await sendNotification(
        `Backend DOWN for ${hours}h+: ${url} has been unreachable since ${new Date(s.firstDownAt).toISOString()}.`
      );
      logger.warn({ url, downSince: s.firstDownAt }, "Backend down notification sent");
    }
  }
}

async function sendNotification(message) {
  try {
    const form = new FormData();
    form.append("body", message);
    form.append("tags", "all");

    const res = await fetch(NOTIFY_URL, { method: "POST", body: form });
    if (!res.ok) {
      logger.error({ status: res.status }, "Notification send failed");
    }
  } catch (err) {
    logger.error({ err }, "Notification send error");
  }
}
