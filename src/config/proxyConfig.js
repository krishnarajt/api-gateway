import config from "./index.js";
import {
	readConfigFromStore,
	writeConfigToStore,
} from "./postgresConfigStore.js";

// ESM live bindings — importers always see the latest value after reloadConfig()
export let defaultBackend = null;
export let mappings = [];
export let allowedOrigins = [];
export let allowedFrontendHosts = [];

// Raw active database config for admin reads / round-tripping
let _raw = {};
export function getRawConfig() {
  return structuredClone(_raw);
}

// ---- Internal helpers ----

function normalizeMappings(rawMappings) {
  return rawMappings.map((m) => {
    const name = (m.name || "").toLowerCase().replace(/[^a-z0-9-_]/g, "");

    let backend = m.backend || null;
    if (backend && !/^https?:\/\//i.test(backend)) {
      backend = `http://${backend.replace(/^\/+/, "")}`;
    }

    return { name, backend };
  });
}

function normalizeBackend(rawBackend) {
  let backend = typeof rawBackend === "string" ? rawBackend.trim() : "";
  if (backend && !/^https?:\/\//i.test(backend)) {
    backend = `http://${backend.replace(/^\/+/, "")}`;
  }
  return backend;
}

function normalizeOrigins(rawOrigins) {
  const origins = Array.isArray(rawOrigins) ? rawOrigins : [];
  return [
    ...new Set(
      origins
        .map((origin) => String(origin || "").trim())
        .filter(Boolean)
        .map((origin) => {
          try {
            return new URL(origin).origin;
          } catch {
            return origin;
          }
        })
    ),
  ];
}

function normalizeConfig(rawCfg) {
  const rawMappings = rawCfg?.mappings || [];
  if (!Array.isArray(rawMappings)) {
    throw new Error("mappings must be an array");
  }

  const cfg = {
    defaultBackend: normalizeBackend(rawCfg?.defaultBackend),
    allowedOrigins: normalizeOrigins(rawCfg?.allowedOrigins),
    mappings: normalizeMappings(rawMappings),
  };

  if (!cfg.defaultBackend) {
    throw new Error("defaultBackend is required");
  }

  for (const m of cfg.mappings) {
    if (!m.name || !m.backend) {
      throw new Error("Each mapping must have name and backend");
    }
  }

  return cfg;
}

function buildAllowedOrigins(cfg) {
  return normalizeOrigins([
    ...(cfg.allowedOrigins || []),
    ...(config.allowedOrigins || []),
  ]);
}

function buildAllowedFrontendHosts(origins) {
  const hosts = new Set();
  for (const o of origins) {
    try {
      const u = new URL(o);
      hosts.add(`${u.protocol}//${u.hostname}`);
      hosts.add(u.origin);
    } catch {
      /* skip malformed */
    }
  }
  return Array.from(hosts);
}

function applyConfig(rawCfg) {
  const cfg = normalizeConfig(rawCfg);

  _raw = cfg;
  defaultBackend = cfg.defaultBackend;
  mappings = cfg.mappings;
  allowedOrigins = buildAllowedOrigins(cfg);
  allowedFrontendHosts = buildAllowedFrontendHosts(allowedOrigins);
}

// ---- Initial load ----
await reloadConfig();

// ---- Getter functions for callers that need guaranteed live values ----
// (ESM live bindings work for direct imports, but closures capture the
//  binding at import time — use these in callbacks like CORS origin checks)

export function getAllowedOrigins() { return allowedOrigins; }
export function getMappings() { return mappings; }
export function getDefaultBackend() { return defaultBackend; }
export function getAllowedFrontendHosts() { return allowedFrontendHosts; }

// ---- Public API ----

/** Re-read active config from Postgres and refresh all in-memory state */
export async function reloadConfig() {
  const cfg = await readConfigFromStore();
  applyConfig(cfg);
}

/** Write new config to Postgres and refresh all in-memory state. */
export async function writeAndReloadConfig(newCfg) {
  const normalizedCfg = normalizeConfig(newCfg);
  const savedCfg = await writeConfigToStore(normalizedCfg);
  applyConfig(savedCfg);
}
