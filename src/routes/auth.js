import { Router } from "express";
import config from "../config/index.js";
import {
	getAllowedOrigins,
	getAllowedFrontendHosts,
} from "../config/proxyConfig.js";
import {
	buildAuthorizeUrl,
	startAuthFlow,
	exchangeCodeForTokens,
	verifyIdToken,
} from "../services/oidc.js";
import {
	createSession,
	createStateRecord,
	deleteSession,
	getAndDeleteState,
} from "../services/sessionStore.js";
import logger from "../utils/logger.js";

const r = Router();

function normalizeCookieDomain(value) {
	if (!value) return undefined;
	if (typeof value !== "string") return undefined;
	let v = value.trim();
	if (!v) return undefined;

	v = v.replace(/^https?:\/\//i, "");
	v = v.split("/")[0];
	v = v.split(":")[0];

	if (!/^[A-Za-z0-9.-]+$/.test(v)) return undefined;
	return v;
}

function setSessionCookie(res, sid, req) {
	const cookieDomain = normalizeCookieDomain(
		config.cookie.domain || req?.headers?.host
	);

	const opts = {
		httpOnly: true,
		secure: Boolean(config.cookie.secure),
		sameSite: config.cookie.sameSite,
		path: "/",
	};

	if (cookieDomain) opts.domain = cookieDomain;

	res.cookie(config.cookie.name, sid, opts);
}

// Normalize a frontend host/URL to scheme://hostname for comparison
function normalizeFrontendHost(val) {
	if (!val || typeof val !== "string") return null;
	let v = val.trim();
	if (!/^https?:\/\//i.test(v)) {
		if (/^localhost(:\d+)?$/.test(v) || /^127\.\d+\.\d+\.\d+/.test(v)) {
			v = `http://${v}`;
		} else {
			v = `https://${v}`;
		}
	}
	v = v.replace(/\/$/, "");
	try {
		const u = new URL(v);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return `${u.protocol}//${u.hostname}`;
	} catch {
		return null;
	}
}

function isAllowedFrontendHost(host) {
	// If no allowlist is configured, skip the check (but log a warning)
	if (getAllowedOrigins().length === 0) {
		logger.warn("No allowedOrigins configured — skipping frontend host validation");
		return true;
	}
	const normalized = normalizeFrontendHost(host);
	if (!normalized) return false;
	return getAllowedFrontendHosts().includes(normalized);
}

r.get("/login", async (req, res, next) => {
	try {
		const requestedNext =
			typeof req.query.next === "string" && req.query.next.startsWith("/")
				? req.query.next
				: "/";
		const rawFrontendHost =
			req.query.frontend_host ||
			req.get("origin") ||
			req.get("referer") ||
			null;
		const normalizedHost = normalizeFrontendHost(rawFrontendHost);

		if (!isAllowedFrontendHost(normalizedHost)) {
			return res.status(400).json({ error: "Disallowed frontend host" });
		}

		const { codeVerifier, codeChallenge, nonce } = startAuthFlow();
		const state = await createStateRecord({
			codeVerifier,
			nonce,
			next: requestedNext,
			returnToHost: normalizedHost,
			createdAt: Date.now(),
		});

		const url = buildAuthorizeUrl({ state, nonce, codeChallenge });
		res.redirect(url);
	} catch (err) {
		next(err);
	}
});

// NOTE: this route path must match the one configured in OIDC_REDIRECT_PATH, but mounted under /auth
r.get(config.oidc.redirectPath.replace(/^\/auth/, ""), async (req, res, next) => {
	try {
		const { state, code } = req.query;
		if (!state || !code) return res.status(400).send("Missing state/code");

		const record = await getAndDeleteState(state);
		if (!record) return res.status(400).send("Invalid state");

		const tokenSet = await exchangeCodeForTokens({
			code,
			codeVerifier: record.codeVerifier,
		});

		// Verify ID token when available; build userInfo from it
		let idPayload = null;
		if (tokenSet.id_token) {
			idPayload = await verifyIdToken(tokenSet.id_token, {
				expectedNonce: record.nonce,
			});
		}

		if (!idPayload) {
			return res.status(502).send("ID token missing or verification failed");
		}

		const userInfo = {
			email: idPayload.email || idPayload.preferred_username || null,
			sub: idPayload.sub,
			name: idPayload.name || null,
		};

		const sid = await createSession(
			{ ...tokenSet, created_at: Date.now() },
			userInfo
		);

		setSessionCookie(res, sid, req);

		const frontendBase = record?.returnToHost;
		if (!frontendBase) {
			logger.warn("No returnToHost in state record, falling back to /");
			return res.redirect("/");
		}

		const nextPath =
			record?.next &&
			typeof record.next === "string" &&
			record.next.startsWith("/")
				? record.next
				: "/";

		res.redirect(`${frontendBase}${nextPath}`);
	} catch (err) {
		next(err);
	}
});

r.post("/logout", async (req, res) => {
	const sid = req.cookies?.[config.cookie.name];
	if (sid) {
		try {
			await deleteSession(sid);
		} catch {
			/* best-effort */
		}
	}

	res.clearCookie(config.cookie.name, {
		httpOnly: true,
		secure: config.cookie.secure,
		sameSite: config.cookie.sameSite,
		path: "/",
		domain: normalizeCookieDomain(config.cookie.domain || req?.headers?.host),
	});

	res.status(204).end();
});

export default r;
