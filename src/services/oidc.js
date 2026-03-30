import config from "../config/index.js";
import { genPkcePair } from "../utils/crypto.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Remote JWKS (issuer discovery not used to stay explicit and simple)
let jwks = null;
let discovery = null;
let jwksRemote = null; // RemoteJWKSet via jose
let jwksLocal = null;  // Optional fallback if we prefetch JSON

function getJWKS() {
	if (jwks) return jwks;
	// Most providers expose .well-known/jwks.json under the issuer
	const url = process.env.OIDC_JWKS_URI;
	jwks = createRemoteJWKSet(new URL(url));
	return jwks;
}

export function buildAuthorizeUrl({ state, nonce, codeChallenge }) {
	const u = new URL(config.oidc.authorizeUrl);
	u.searchParams.set("client_id", config.oidc.clientId);
	u.searchParams.set(
		"redirect_uri",
		new URL(config.oidc.redirectPath, config.baseUrl).toString()
	);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", config.oidc.scopes);
	u.searchParams.set("state", state);
	u.searchParams.set("nonce", nonce);
	u.searchParams.set("code_challenge", codeChallenge);
	u.searchParams.set("code_challenge_method", "S256");
	return u.toString();
}

export function startAuthFlow() {
	const { codeVerifier, codeChallenge } = genPkcePair();
	const nonce = crypto.randomUUID().replace(/-/g, "");
	return { codeVerifier, codeChallenge, nonce };
}

export async function exchangeCodeForTokens({ code, codeVerifier }) {
	const res = await fetch(config.oidc.tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: new URL(config.oidc.redirectPath, config.baseUrl).toString(),
			client_id: config.oidc.clientId,
			client_secret: config.oidc.clientSecret,
			code_verifier: codeVerifier,
		}),
	});
	if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
	return res.json();
}

export async function refreshTokens(refreshToken) {
	const res = await fetch(config.oidc.tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: config.oidc.clientId,
			client_secret: config.oidc.clientSecret,
		}),
	});
	if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
	return res.json();
}

export async function revokeToken(token, hint) {
	if (!config.oidc.revocationUrl) return true; // not configured
	const res = await fetch(config.oidc.revocationUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token,
			token_type_hint: hint || "access_token",
			client_id: config.oidc.clientId,
			client_secret: config.oidc.clientSecret,
		}),
	});
	// RFC 7009: 200 OK even if token unknown
	return res.ok;
}

export async function fetchUserinfo(accessToken) {
	const res = await fetch(config.oidc.userinfoUrl, {
		headers: { authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) return null;
	return res.json();
}
async function getDiscovery() {
	if (discovery) return discovery;
	const url = new URL("./.well-known/openid-configuration", config.oidc.issuer).toString();
	const res = await fetch(url);
	if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${await res.text()}`);
	discovery = await res.json();
	return discovery;
}
/**
 * Verify ID token contents (issuer, audience, exp, iat) and optional nonce.
 */
// src/services/oidc.js
export async function verifyIdToken(idToken, { expectedNonce } = {}) {
	if (!idToken) return false;

	const jwksSet = await getJWKS();
	const meta = await getDiscovery(); // ← read issuer from discovery
	const expectedIssuer = meta.issuer; // ← exact string, including trailing slash

	const { payload } = await jwtVerify(idToken, jwksSet, {
		issuer: expectedIssuer, // ← no replace(), exact match
		audience: config.oidc.clientId,
		maxTokenAge: config.oidc.idTokenMaxAge || undefined,
	});

	if (expectedNonce && payload.nonce !== expectedNonce) throw new Error("Nonce mismatch");
	return payload;
}
