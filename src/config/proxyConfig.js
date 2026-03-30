import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import config from "./index.js";

const cfgPath = path.resolve(process.cwd(), "config.yml");

// ESM live bindings — importers always see the latest value after reloadConfig()
export let defaultBackend = null;
export let mappings = [];
export let allowedOrigins = [];
export let allowedFrontendHosts = [];

// Raw parsed YAML for admin reads / round-tripping
let _raw = {};
export function getRawConfig() {
  return structuredClone(_raw);
}

// ---- Internal helpers ----

function normalizeMappings(rawMappings) {
  return (rawMappings || []).map((m) => {
    const name = (m.name || "").toLowerCase().replace(/[^a-z0-9-_]/g, "");

    let backend = m.backend || null;
    if (backend && !/^https?:\/\//i.test(backend)) {
      backend = `http://${backend.replace(/^\/+/, "")}`;
    }

    return { name, backend };
  });
}

function buildAllowedOrigins(cfg) {
  return [
    ...new Set([
      ...(cfg.allowedOrigins || []),
      ...(config.allowedOrigins || []),
    ]),
  ];
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

function loadFromDisk() {
  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = {
    defaultBackend: undefined,
    mappings: [],
    allowedOrigins: [],
    ...yaml.load(raw),
  };

  if (!cfg.defaultBackend) {
    throw new Error("config.yml: defaultBackend is required");
  }

  _raw = cfg;
  defaultBackend = cfg.defaultBackend;
  mappings = normalizeMappings(cfg.mappings);
  allowedOrigins = buildAllowedOrigins(cfg);
  allowedFrontendHosts = buildAllowedFrontendHosts(allowedOrigins);
}

// ---- Initial load ----
loadFromDisk();

// ---- Getter functions for callers that need guaranteed live values ----
// (ESM live bindings work for direct imports, but closures capture the
//  binding at import time — use these in callbacks like CORS origin checks)

export function getAllowedOrigins() { return allowedOrigins; }
export function getMappings() { return mappings; }
export function getDefaultBackend() { return defaultBackend; }

// ---- Public API ----

/** Re-read config.yml from disk and refresh all in-memory state */
export function reloadConfig() {
  loadFromDisk();
}

/** Write new config to disk and reload. Accepts the raw config object. */
export function writeAndReloadConfig(newCfg) {
  if (!newCfg.defaultBackend) {
    throw new Error("defaultBackend is required");
  }
  const yamlStr = yaml.dump(newCfg, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(cfgPath, yamlStr, "utf8");
  loadFromDisk();
}
