import config from "../config/index.js";

const isSafe = (method) => ["GET", "HEAD", "OPTIONS", "TRACE"].includes(method);

export default function csrfCheck(req, res, next) {
	if (isSafe(req.method)) return next();

	// Prefer Origin when present, otherwise fall back to Referer
	const origin = req.headers.origin || "";
	const referer = req.headers.referer || "";
	const allowed = (config.allowedOrigins || []).some(
		(o) => (origin && origin === o) || (referer && referer.startsWith(o))
	);

	// If no allowedOrigins configured, enforce same-origin by Host header check
	if (!allowed && (!config.allowedOrigins || config.allowedOrigins.length === 0)) {
		const url = new URL(req.protocol + "://" + req.get("host"));
		if (origin && origin !== url.origin)
			return res.status(403).json({ error: "CSRF check failed" });
		if (referer && !referer.startsWith(url.origin))
			return res.status(403).json({ error: "CSRF check failed" });
	}

	if (config.allowedOrigins && config.allowedOrigins.length > 0 && !allowed) {
		return res.status(403).json({ error: "CSRF check failed" });
	}

	return next();
}
