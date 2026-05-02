import "dotenv/config";

const must = (k) => {
	const v = process.env[k];
	if (!v) throw new Error(`Missing env: ${k}`);
	return v;
};
const bool = (k, def = false) =>
	process.env[k] == null
		? def
		: ["1", "true", "yes"].includes(String(process.env[k]).toLowerCase());
const num = (k, def) => (process.env[k] == null ? def : Number(process.env[k]));
const parseList = (v) =>
	v
		? v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

const config = {
	nodeEnv: process.env.NODE_ENV || "development",
	port: Number(process.env.PORT || 8080),
	baseUrl: must("APP_BASE_URL"),

	cookie: {
		name: process.env.SESSION_COOKIE_NAME || "sid",
		domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
		secure: bool("SESSION_COOKIE_SECURE", true),
		sameSite: process.env.SESSION_COOKIE_SAMESITE || "none",
	},

	redis: {
		host: must("REDIS_HOST"),
		port: num("REDIS_PORT", 6379),
		password: process.env.REDIS_PASSWORD || undefined,
	},

	database: {
		url: must("DATABASE_URL"),
		schema: process.env.DB_SCHEMA || "api_gateway",
		bootstrapConfigPath: process.env.CONFIG_BOOTSTRAP_PATH || "config.yml",
		poolMax: num("DATABASE_POOL_MAX", 10),
		idleTimeoutMillis: num("DATABASE_IDLE_TIMEOUT_MS", 30_000),
		connectionTimeoutMillis: num("DATABASE_CONNECTION_TIMEOUT_MS", 10_000),
	},

	oidc: {
		issuer: must("OIDC_ISSUER"),
		authorizeUrl: must("OIDC_AUTHORIZATION_ENDPOINT"),
		tokenUrl: must("OIDC_TOKEN_ENDPOINT"),
		revocationUrl: process.env.OIDC_REVOCATION_ENDPOINT || null,
		userinfoUrl: must("OIDC_USERINFO_ENDPOINT"),
		clientId: must("OIDC_CLIENT_ID"),
		clientSecret: must("OIDC_CLIENT_SECRET"),
		redirectPath: must("OIDC_REDIRECT_PATH"),
		scopes: process.env.OIDC_SCOPES || "openid profile email offline_access",
		idTokenMaxAge: num("ID_TOKEN_MAX_AGE_SECONDS", 0), // 0 = disabled
	},

	refreshSkewSeconds: num("TOKEN_REFRESH_SKEW_SECONDS", 60),
	allowedOrigins: parseList(process.env.ALLOWED_ORIGINS || ""),
	domain: process.env.APP_DOMAIN || undefined,
};

export default config;
