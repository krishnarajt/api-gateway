import config from "../config/index.js";
import { getSession, setSession } from "../services/sessionStore.js";
import { fetchUserinfo, refreshTokens } from "../services/oidc.js";

function bearerTokenFromRequest(req) {
	const header = req.get?.("authorization") || req.headers?.authorization || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : null;
}

async function authenticateBearer(req, token) {
	const userinfo = await fetchUserinfo(token);
	if (!userinfo?.sub) return false;

	req.auth = {
		source: "bearer",
		sid: null,
		tokenSet: {
			access_token: token,
			token_type: "Bearer",
			user: {
				email: userinfo.email || userinfo.preferred_username || null,
				sub: userinfo.sub,
				name: userinfo.name || userinfo.preferred_username || null,
			},
		},
	};
	return true;
}

function userFromUserinfo(userinfo) {
	if (!userinfo?.sub) return null;

	return {
		email: userinfo.email || userinfo.preferred_username || null,
		sub: userinfo.sub,
		name: userinfo.name || userinfo.preferred_username || null,
	};
}

async function hydrateMissingSessionUser(sid, tokenSet) {
	if (tokenSet.user?.sub) return tokenSet;

	const user = userFromUserinfo(await fetchUserinfo(tokenSet.access_token));
	if (!user) return null;

	const hydrated = { ...tokenSet, user };
	await setSession(sid, hydrated);
	return hydrated;
}

export default async function requireAuth(req, res, next) {
	try {
		if (req.method === "OPTIONS") return next();

		const sid = req.cookies?.[config.cookie.name];
		const sess = await getSession(sid);
		const bearerToken = bearerTokenFromRequest(req);
		if (!sess?.access_token) {
			if (bearerToken && (await authenticateBearer(req, bearerToken))) return next();
			return res.status(401).json({ error: "Unauthorized" });
		}

		// Refresh if access token is near expiry and we have a refresh token
		const now = Math.floor(Date.now() / 1000);
		const skew = config.refreshSkewSeconds;
		let tokenSet = sess;
		if (sess.access_expires_at && sess.access_expires_at - now <= skew && sess.refresh_token) {
			try {
				const refreshed = await refreshTokens(sess.refresh_token);
				tokenSet = { ...sess, ...refreshed };
				await setSession(sid, tokenSet);
			} catch (_e) {
				// Refresh failed; fall back to 401 to force re-login
				return res.status(401).json({ error: "Session expired" });
			}
		}

		tokenSet = await hydrateMissingSessionUser(sid, tokenSet);
		if (!tokenSet) return res.status(401).json({ error: "Unauthorized" });

		req.auth = { sid, tokenSet };
		return next();
	} catch (err) {
		return next(err);
	}
}
