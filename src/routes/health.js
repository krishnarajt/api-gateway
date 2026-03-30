import { Router } from "express";
import { redis } from "../services/sessionStore.js";

const r = Router();

// Liveness — app process is running
r.get("/health", (_req, res) => res.json({ ok: true }));

// Readiness — app can serve traffic (Redis is reachable)
r.get("/ready", async (_req, res) => {
	try {
		await redis.ping();
		res.json({ ok: true });
	} catch {
		res.status(503).json({ ok: false, reason: "redis unreachable" });
	}
});

export default r;
