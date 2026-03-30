import { randomBytes, createHash } from "crypto";
import { base64url } from "jose";

/** random URL-safe string */
export function randStr(len = 32) {
	return base64url.encode(randomBytes(len));
}

export function genPkcePair() {
	const codeVerifier = base64url.encode(randomBytes(32));
	const codeChallenge = base64url.encode(createHash("sha256").update(codeVerifier).digest());
	return { codeVerifier, codeChallenge, method: "S256" };
}
