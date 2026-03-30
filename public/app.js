// ---- Helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function on(sel, event, fn) {
  const el = $(sel);
  if (el) el.addEventListener(event, fn);
  else console.warn(`Element not found: ${sel}`);
}

function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast ${ok ? "toast-ok" : "toast-bad"}`;
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, ok: res.ok, data };
}

// ---- State ----
let currentUser = null;
let currentConfig = null;
let healthInterval = null;

// ---- Auth ----
async function checkAuth() {
  const { status, data } = await apiJson("/whoami/me");
  if (status === 200 && data) {
    currentUser = data;
    showLoggedIn(data);
    return true;
  }
  showLoggedOut();
  return false;
}

function showLoggedIn(user) {
  const name = user.name || user.email || user.sub || "User";
  $("#userName").textContent = name;
  $("#userSection").style.display = "flex";
  $("#loginBtn").style.display = "none";
  $("#navTabs").style.display = "flex";
  $("#status").textContent = "connected";
  $("#status").className = "pill pill-ok";

  // Hide login page, show dashboard
  $$("#loginPage, #loginBtn2").forEach((el) => (el.style.display = "none"));
  switchPage("dashboard");
}

function showLoggedOut() {
  currentUser = null;
  $("#userSection").style.display = "none";
  $("#loginBtn").style.display = "";
  $("#navTabs").style.display = "none";
  $("#status").textContent = "logged out";
  $("#status").className = "pill pill-bad";

  // Show login page, hide all others
  $$(".page").forEach((p) => p.classList.remove("active"));
  $("#loginPage").style.display = "";
  $("#loginPage").classList.add("active");
}

// ---- Navigation ----
function switchPage(name) {
  $$(".page").forEach((p) => p.classList.remove("active"));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.page === name));
  const page = $(`#${name}Page`);
  if (page) page.classList.add("active");
  $("#loginPage").classList.remove("active");

  if (name === "dashboard") loadDashboard();
  if (name === "config") loadConfig();
}

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => switchPage(tab.dataset.page))
);

// ---- Dashboard ----
async function loadDashboard() {
  // Session info
  const el = $("#sessionInfo");
  if (currentUser) {
    el.innerHTML = `
      <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 16px; font-size:14px;">
        <span style="color:var(--text-muted)">Name</span><span>${esc(currentUser.name || "—")}</span>
        <span style="color:var(--text-muted)">Email</span><span>${esc(currentUser.email || "—")}</span>
        <span style="color:var(--text-muted)">Sub</span><span style="font-family:var(--mono);font-size:12px">${esc(currentUser.sub || "—")}</span>
      </div>`;
  }
  loadHealth();
}

async function loadHealth() {
  const grid = $("#healthGrid");
  const { ok, data } = await apiJson("/admin/health");
  if (!ok || !data) {
    grid.innerHTML = '<div class="text-muted">Failed to load health data.</div>';
    return;
  }

  const entries = Object.entries(data);
  if (entries.length === 0) {
    grid.innerHTML = '<div class="text-muted">No backends configured.</div>';
    return;
  }

  grid.innerHTML = entries
    .map(([url, s]) => {
      const dotClass = s.status === "up" ? "dot-up" : s.status === "down" ? "dot-down" : "dot-unknown";
      const statusLabel = s.status === "up" ? "Healthy" : s.status === "down" ? "Unreachable" : "Checking...";
      const latency = s.latencyMs != null ? `${s.latencyMs}ms` : "—";
      const lastCheck = s.lastCheck ? timeAgo(s.lastCheck) : "never";
      const downSince = s.firstDownAt ? new Date(s.firstDownAt).toLocaleString() : null;

      return `
        <div class="health-card">
          <div class="url">${esc(url)}</div>
          <div class="meta">
            <span><span class="dot ${dotClass}"></span> ${statusLabel}</span>
            <span>Latency: ${latency}</span>
            <span>Checked: ${lastCheck}</span>
            ${downSince ? `<span style="color:var(--red)">Down since: ${esc(downSince)}</span>` : ""}
          </div>
        </div>`;
    })
    .join("");
}

// ---- Config Editor ----
async function loadConfig() {
  const { ok, data } = await apiJson("/admin/config");
  if (!ok || !data) {
    toast("Failed to load config", false);
    return;
  }
  currentConfig = data;
  renderConfig(data);
}

function renderConfig(cfg) {
  $("#cfgDefaultBackend").value = cfg.defaultBackend || "";
  renderOrigins(cfg.allowedOrigins || []);
  renderMappings(cfg.mappings || []);
}

function renderOrigins(origins) {
  const list = $("#originsList");
  list.innerHTML = origins
    .map(
      (o, i) =>
        `<span class="origin-tag">${esc(o)}<button class="remove-origin" data-idx="${i}">&times;</button></span>`
    )
    .join("");

  list.querySelectorAll(".remove-origin").forEach((btn) =>
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      currentConfig.allowedOrigins.splice(idx, 1);
      renderOrigins(currentConfig.allowedOrigins);
    })
  );
}

function renderMappings(maps) {
  const list = $("#mappingsList");
  list.innerHTML = maps.length
    ? maps
        .map(
          (m, i) => `
        <div class="mapping-row">
          <input type="text" class="config-input" value="${esc(m.name || "")}" placeholder="app name" data-idx="${i}" data-field="name" />
          <input type="text" class="config-input" value="${esc(m.backend || "")}" placeholder="http://backend:port" data-idx="${i}" data-field="backend" />
          <button class="btn btn-danger btn-sm remove-mapping" data-idx="${i}">&times;</button>
        </div>`
        )
        .join("")
    : '<div class="text-muted">No mappings defined.</div>';

  // Bind change events
  list.querySelectorAll("input[data-idx]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const idx = Number(inp.dataset.idx);
      const field = inp.dataset.field;
      currentConfig.mappings[idx][field] = inp.value.trim();
    })
  );

  list.querySelectorAll(".remove-mapping").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentConfig.mappings.splice(Number(btn.dataset.idx), 1);
      renderMappings(currentConfig.mappings);
    })
  );
}

on("#addOriginBtn", "click", () => {
  const inp = $("#newOriginInput");
  const val = inp.value.trim();
  if (!val) return;
  if (!currentConfig.allowedOrigins) currentConfig.allowedOrigins = [];
  currentConfig.allowedOrigins.push(val);
  renderOrigins(currentConfig.allowedOrigins);
  inp.value = "";
});

on("#addMappingBtn", "click", () => {
  if (!currentConfig.mappings) currentConfig.mappings = [];
  currentConfig.mappings.push({ name: "", backend: "" });
  renderMappings(currentConfig.mappings);
});

on("#saveConfigBtn", "click", async () => {
  const cfg = {
    defaultBackend: $("#cfgDefaultBackend").value.trim(),
    allowedOrigins: currentConfig.allowedOrigins || [],
    mappings: currentConfig.mappings || [],
  };

  if (!cfg.defaultBackend) {
    toast("Default backend is required", false);
    return;
  }

  const { ok, data } = await apiJson("/admin/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });

  if (ok) {
    currentConfig = data.config || cfg;
    toast("Config saved and applied!");
    renderConfig(currentConfig);
    // Refresh health after config change
    loadHealth();
  } else {
    toast(data?.error || "Failed to save config", false);
  }
});

on("#reloadConfigBtn", "click", async () => {
  const { ok, data } = await apiJson("/admin/config/reload", { method: "POST" });
  if (ok) {
    currentConfig = data.config;
    renderConfig(currentConfig);
    toast("Config reloaded from disk");
    loadHealth();
  } else {
    toast(data?.error || "Reload failed", false);
  }
});

// ---- API Tester ----
on("#apiSendBtn", "click", sendApiRequest);

async function sendApiRequest() {
  const method = $("#apiMethod").value;
  const url = $("#apiUrl").value.trim();
  const bodyStr = $("#apiBody").value.trim();

  if (!url) return;

  const statusEl = $("#apiStatus");
  const latencyEl = $("#apiLatency");
  const outputEl = $("#apiOutput");

  statusEl.textContent = "...";
  statusEl.className = "pill pill-muted";
  outputEl.textContent = "Loading...";
  latencyEl.textContent = "";

  const opts = { method };
  if (bodyStr && ["POST", "PUT", "PATCH"].includes(method)) {
    opts.headers = { "content-type": "application/json" };
    opts.body = bodyStr;
  }

  const start = Date.now();
  try {
    const res = await api(url, opts);
    const elapsed = Date.now() - start;
    latencyEl.textContent = `${elapsed}ms`;

    statusEl.textContent = `${res.status} ${res.statusText}`;
    statusEl.className = `pill ${res.ok ? "pill-ok" : "pill-bad"}`;

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const data = await res.json();
      outputEl.textContent = JSON.stringify(data, null, 2);
    } else {
      outputEl.textContent = await res.text();
    }
  } catch (err) {
    statusEl.textContent = "Error";
    statusEl.className = "pill pill-bad";
    outputEl.textContent = String(err);
  }
}

// Quick action buttons
$$("[data-quick]").forEach((btn) =>
  btn.addEventListener("click", () => {
    $("#apiUrl").value = btn.dataset.quick;
    $("#apiMethod").value = "GET";
    $("#apiBody").value = "";
    switchPage("tester");
    sendApiRequest();
  })
);

// ---- Login / Logout ----
function doLogin() {
  window.location.href = `/auth/login?frontend_host=${encodeURIComponent(window.location.origin)}&next=/`;
}

on("#loginBtn", "click", doLogin);
on("#loginBtn2", "click", doLogin);
on("#logoutBtn", "click", async () => {
  await api("/auth/logout", { method: "POST" });
  showLoggedOut();
  toast("Logged out");
});

// ---- Health refresh ----
on("#refreshHealthBtn", "click", loadHealth);

// ---- Utils ----
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---- Init ----
(async function init() {
  try {
    const r = await fetch("/healthz");
    if (!r.ok) {
      $("#status").textContent = "unreachable";
      $("#status").className = "pill pill-bad";
    }
  } catch {
    $("#status").textContent = "unreachable";
    $("#status").className = "pill pill-bad";
    return;
  }

  await checkAuth();
})();
