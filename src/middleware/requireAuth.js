import config from "../config/index.js";
import { getSession, setSession } from "../services/sessionStore.js";
import { refreshTokens } from "../services/oidc.js";

export default async function requireAuth(req, res, next) {
	try {
		if (req.method === "OPTIONS") return next();

		const sid = req.cookies?.[config.cookie.name];
		const sess = await getSession(sid);
		if (!sess?.access_token) return res.status(401).json({ error: "Unauthorized" });

		// Refresh if access token is near expiry and we have a refresh token
		const now = Math.floor(Date.now() / 1000);
		const skew = config.refreshSkewSeconds;
		if (sess.access_expires_at && sess.access_expires_at - now <= skew && sess.refresh_token) {
			try {
				const refreshed = await refreshTokens(sess.refresh_token);
				await setSession(sid, {
					...sess,
					...refreshed,
				});
				req.auth = { sid, tokenSet: { ...sess, ...refreshed } };
			} catch (_e) {
				// Refresh failed; fall back to 401 to force re-login
				return res.status(401).json({ error: "Session expired" });
			}
		} else {
			req.auth = { sid, tokenSet: sess };
		}

		return next();
	} catch (err) {
		return next(err);
	}
}
