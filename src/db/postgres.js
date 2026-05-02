import pg from "pg";
import config from "../config/index.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const { Pool } = pg;

function normalizeIdentifier(value, label) {
	const identifier = String(value || "").trim();
	if (!IDENTIFIER_RE.test(identifier)) {
		throw new Error(`${label} must be a valid PostgreSQL identifier`);
	}
	return identifier;
}

export function quoteIdentifier(identifier) {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export const dbSchema = normalizeIdentifier(
	config.database.schema || "api_gateway",
	"DB_SCHEMA"
);

export const gatewayConfigTable = `${quoteIdentifier(dbSchema)}.${quoteIdentifier(
	"api_gateway_config"
)}`;

export const pool = new Pool({
	connectionString: config.database.url,
	max: config.database.poolMax,
	idleTimeoutMillis: config.database.idleTimeoutMillis,
	connectionTimeoutMillis: config.database.connectionTimeoutMillis,
});

export async function ensureDatabaseSchema() {
	if (dbSchema === "public") return;
	await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(dbSchema)}`);
}

export async function closeDatabase() {
	await pool.end();
}
