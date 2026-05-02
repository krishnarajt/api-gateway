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
const validationMessage =
  /defaultBackend|required|must|Each mapping|allowedOrigins|mappings/i;

// All admin routes require authentication
r.use(requireAuth);

// ---- Config endpoints ----

/** GET /admin/config — return current Postgres-backed config */
r.get("/config", (_req, res) => {
  res.json(getRawConfig());
});

/** PUT /admin/config — replace active config in Postgres and hot-refresh */
r.put("/config", async (req, res) => {
  try {
    const newCfg = req.body;

    if (!newCfg || !newCfg.defaultBackend) {
      return res.status(400).json({ error: "defaultBackend is required" });
    }
    if (!Array.isArray(newCfg.mappings)) {
      return res.status(400).json({ error: "mappings must be an array" });
    }
    if (
      newCfg.allowedOrigins != null &&
      !Array.isArray(newCfg.allowedOrigins)
    ) {
      return res.status(400).json({ error: "allowedOrigins must be an array" });
    }
    for (const m of newCfg.mappings) {
      if (!m.name || !m.backend) {
        return res.status(400).json({
          error: "Each mapping must have name and backend",
        });
      }
    }

    await writeAndReloadConfig(newCfg);

    // Re-sync health checker with new backend list
    refreshBackends(getMappings(), getDefaultBackend());

    logger.info("Config updated via admin API and Postgres");
    res.json({ ok: true, config: getRawConfig() });
  } catch (err) {
    logger.error({ err }, "Config update failed");
    const status = validationMessage.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** POST /admin/config/reload — re-read active config from Postgres */
r.post("/config/reload", async (_req, res) => {
  try {
    await reloadConfig();
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
