import Redis from "ioredis";
import config from "../config/index.js";
import { randStr } from "../utils/crypto.js";

export const redis = new Redis({
	host: config.redis.host,
	port: config.redis.port,
	password: config.redis.password,
});

// Keys: session:{sid}, state:{state}
const ttl = {
	session: 60 * 60 * 8, // 8h absolute envelope (rolling on set)
	state: 60 * 10,
};

export async function createStateRecord(payload) {
	const state = randStr(24);
	await redis.setex(`state:${state}`, ttl.state, JSON.stringify(payload));
	return state;
}

export async function getAndDeleteState(state) {
	const key = `state:${state}`;
	const val = await redis.getdel(key);
	return val ? JSON.parse(val) : null;
}

export async function createSession(tokenSet, userInfo = null) {
	const sid = randStr(24);
	// Normalize a few fields we’ll depend on
	const now = Math.floor(Date.now() / 1000);
	const normalized = normalizeTokenSet(tokenSet, now);
	if (userInfo) normalized.user = userInfo;
	await redis.setex(`session:${sid}`, ttl.session, JSON.stringify(normalized));
	return sid;
}

export async function getSession(sid) {
	if (!sid) return null;
	const val = await redis.get(`session:${sid}`);
	return val ? JSON.parse(val) : null;
}

export async function setSession(sid, tokenSet) {
	const now = Math.floor(Date.now() / 1000);
	const normalized = normalizeTokenSet(tokenSet, now);
	await redis.setex(`session:${sid}`, ttl.session, JSON.stringify(normalized));
}

export async function deleteSession(sid) {
	await redis.del(`session:${sid}`);
}

function normalizeTokenSet(tokenSet, now) {
	// If provider returned expires_in, compute access_expires_at
	const access_expires_at = tokenSet.expires_in
		? now + Number(tokenSet.expires_in)
		: tokenSet.access_expires_at || 0;
	const result = {
		access_token: tokenSet.access_token,
		id_token: tokenSet.id_token || null,
		refresh_token: tokenSet.refresh_token || null,
		token_type: tokenSet.token_type || "Bearer",
		scope: tokenSet.scope || null,
		created_at: tokenSet.created_at || now * 1000,
		access_expires_at,
	};
	if (tokenSet.user) result.user = tokenSet.user;
	return result;
}
