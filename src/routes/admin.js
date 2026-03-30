import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import {
  getRawConfig,
  writeAndReloadConfig,
  reloadConfig,
  getMappings,
  getDefaultBackend,
} from "../config/proxyConfig.js";
import {
  getHealthState,
  refreshBackends,
} from "../services/healthChecker.js";
import logger from "../utils/logger.js";

const r = Router();

// All admin routes require authentication
r.use(requireAuth);

// ---- Config endpoints ----

/** GET /admin/config — return current config.yml contents */
r.get("/config", (_req, res) => {
  res.json(getRawConfig());
});

/** PUT /admin/config — replace entire config.yml, reload, and refresh health checker */
r.put("/config", (req, res) => {
  try {
    const newCfg = req.body;

    if (!newCfg || !newCfg.defaultBackend) {
      return res.status(400).json({ error: "defaultBackend is required" });
    }
    if (!Array.isArray(newCfg.mappings)) {
      return res.status(400).json({ error: "mappings must be an array" });
    }
    for (const m of newCfg.mappings) {
      if (!m.name || !m.backend) {
        return res.status(400).json({
          error: "Each mapping must have name and backend",
        });
      }
    }

    writeAndReloadConfig(newCfg);

    // Re-sync health checker with new backend list
    refreshBackends(getMappings(), getDefaultBackend());

    logger.info("Config updated via admin API");
    res.json({ ok: true, config: getRawConfig() });
  } catch (err) {
    logger.error({ err }, "Config update failed");
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/config/reload — re-read config.yml from disk without writing */
r.post("/config/reload", (_req, res) => {
  try {
    reloadConfig();
    refreshBackends(getMappings(), getDefaultBackend());
    res.json({ ok: true, config: getRawConfig() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Health endpoints ----

/** GET /admin/health — return health state for all backends */
r.get("/health", (_req, res) => {
  res.json(getHealthState());
});

export default r;
