import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import config from "./index.js";
import {
	dbSchema,
	ensureDatabaseSchema,
	gatewayConfigTable,
	pool,
} from "../db/postgres.js";
import logger from "../utils/logger.js";

const ACTIVE_CONFIG_KEY = "active";

let tableReady = false;

async function ensureConfigTable() {
	if (tableReady) return;

	await ensureDatabaseSchema();
	await pool.query(`
		CREATE TABLE IF NOT EXISTS ${gatewayConfigTable} (
			config_key text PRIMARY KEY,
			default_backend text NOT NULL,
			allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
			mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT api_gateway_config_allowed_origins_array
				CHECK (jsonb_typeof(allowed_origins) = 'array'),
			CONSTRAINT api_gateway_config_mappings_array
				CHECK (jsonb_typeof(mappings) = 'array')
		)
	`);

	tableReady = true;
}

function parseJsonArray(value) {
	if (Array.isArray(value)) return value;
	if (value == null) return [];
	if (typeof value === "string") {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	}
	return [];
}

function rowToConfig(row) {
	return {
		defaultBackend: row.default_backend,
		allowedOrigins: parseJsonArray(row.allowed_origins),
		mappings: parseJsonArray(row.mappings),
	};
}

function loadBootstrapConfig() {
	if (!config.database.bootstrapConfigPath) return null;

	const cfgPath = path.resolve(process.cwd(), config.database.bootstrapConfigPath);
	if (!fs.existsSync(cfgPath)) return null;

	const raw = fs.readFileSync(cfgPath, "utf8");
	const parsed = yaml.load(raw) || {};
	if (!parsed.defaultBackend) {
		throw new Error(`${config.database.bootstrapConfigPath}: defaultBackend is required`);
	}

	return {
		defaultBackend: parsed.defaultBackend,
		allowedOrigins: Array.isArray(parsed.allowedOrigins) ? parsed.allowedOrigins : [],
		mappings: Array.isArray(parsed.mappings) ? parsed.mappings : [],
	};
}

export async function readConfigFromStore() {
	await ensureConfigTable();

	const result = await pool.query(
		`
			SELECT default_backend, allowed_origins, mappings
			FROM ${gatewayConfigTable}
			WHERE config_key = $1
		`,
		[ACTIVE_CONFIG_KEY]
	);

	if (result.rows[0]) return rowToConfig(result.rows[0]);

	const bootstrapConfig = loadBootstrapConfig();
	if (!bootstrapConfig) {
		throw new Error(
			`No active API gateway config found in ${dbSchema}.api_gateway_config`
		);
	}

	const seeded = await writeConfigToStore(bootstrapConfig);
	logger.info(
		{ table: `${dbSchema}.api_gateway_config` },
		"Seeded API gateway config from bootstrap file"
	);
	return seeded;
}

export async function writeConfigToStore(cfg) {
	await ensureConfigTable();

	const result = await pool.query(
		`
			INSERT INTO ${gatewayConfigTable}
				(config_key, default_backend, allowed_origins, mappings)
			VALUES ($1, $2, $3::jsonb, $4::jsonb)
			ON CONFLICT (config_key) DO UPDATE SET
				default_backend = EXCLUDED.default_backend,
				allowed_origins = EXCLUDED.allowed_origins,
				mappings = EXCLUDED.mappings,
				updated_at = now()
			RETURNING default_backend, allowed_origins, mappings
		`,
		[
			ACTIVE_CONFIG_KEY,
			cfg.defaultBackend,
			JSON.stringify(cfg.allowedOrigins || []),
			JSON.stringify(cfg.mappings || []),
		]
	);

	return rowToConfig(result.rows[0]);
}
