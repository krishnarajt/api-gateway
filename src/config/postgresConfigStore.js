import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import config from "./index.js";
import {
	dbSchema,
	ensureDatabaseSchema,
	gatewayAllowedOriginsTable,
	gatewayConfigTable,
	gatewayMappingsTable,
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
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	await pool.query(`
		CREATE TABLE IF NOT EXISTS ${gatewayAllowedOriginsTable} (
			config_key text NOT NULL REFERENCES ${gatewayConfigTable}(config_key) ON DELETE CASCADE,
			origin text NOT NULL,
			sort_order integer NOT NULL DEFAULT 0,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (config_key, origin),
			CONSTRAINT api_gateway_allowed_origin_not_blank
				CHECK (btrim(origin) <> '')
		)
	`);
	await pool.query(`
		CREATE TABLE IF NOT EXISTS ${gatewayMappingsTable} (
			config_key text NOT NULL REFERENCES ${gatewayConfigTable}(config_key) ON DELETE CASCADE,
			name text NOT NULL,
			backend text NOT NULL,
			sort_order integer NOT NULL DEFAULT 0,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (config_key, name),
			CONSTRAINT api_gateway_mapping_name_not_blank
				CHECK (btrim(name) <> ''),
			CONSTRAINT api_gateway_mapping_backend_not_blank
				CHECK (btrim(backend) <> '')
		)
	`);
	await migrateLegacyJsonColumns();

	tableReady = true;
}

async function legacyColumnExists(columnName) {
	const result = await pool.query(
		`
			SELECT EXISTS (
				SELECT 1
				FROM information_schema.columns
				WHERE table_schema = $1
				  AND table_name = 'api_gateway_config'
				  AND column_name = $2
			) AS exists
		`,
		[dbSchema, columnName]
	);

	return Boolean(result.rows[0]?.exists);
}

async function migrateLegacyJsonColumns() {
	const hasAllowedOrigins = await legacyColumnExists("allowed_origins");
	const hasMappings = await legacyColumnExists("mappings");

	if (hasAllowedOrigins) {
		await pool.query(`
			DELETE FROM ${gatewayAllowedOriginsTable}
			WHERE config_key IN (SELECT config_key FROM ${gatewayConfigTable})
		`);
		await pool.query(`
			WITH origins AS (
				SELECT
					c.config_key,
					o.origin,
					(o.ordinality - 1)::integer AS sort_order
				FROM ${gatewayConfigTable} c
				CROSS JOIN LATERAL jsonb_array_elements_text(
					CASE
						WHEN jsonb_typeof(c.allowed_origins) = 'array' THEN c.allowed_origins
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS o(origin, ordinality)
				WHERE btrim(o.origin) <> ''
			),
			deduped AS (
				SELECT DISTINCT ON (config_key, origin)
					config_key,
					origin,
					sort_order
				FROM origins
				ORDER BY config_key, origin, sort_order
			)
			INSERT INTO ${gatewayAllowedOriginsTable}
				(config_key, origin, sort_order)
			SELECT config_key, origin, sort_order
			FROM deduped
			ON CONFLICT (config_key, origin) DO UPDATE SET
				sort_order = EXCLUDED.sort_order,
				updated_at = now()
		`);
	}

	if (hasMappings) {
		await pool.query(`
			DELETE FROM ${gatewayMappingsTable}
			WHERE config_key IN (SELECT config_key FROM ${gatewayConfigTable})
		`);
		await pool.query(`
			WITH mappings AS (
				SELECT
					c.config_key,
					m.mapping ->> 'name' AS name,
					m.mapping ->> 'backend' AS backend,
					(m.ordinality - 1)::integer AS sort_order
				FROM ${gatewayConfigTable} c
				CROSS JOIN LATERAL jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(c.mappings) = 'array' THEN c.mappings
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS m(mapping, ordinality)
				WHERE btrim(COALESCE(m.mapping ->> 'name', '')) <> ''
				  AND btrim(COALESCE(m.mapping ->> 'backend', '')) <> ''
			),
			deduped AS (
				SELECT DISTINCT ON (config_key, name)
					config_key,
					name,
					backend,
					sort_order
				FROM mappings
				ORDER BY config_key, name, sort_order
			)
			INSERT INTO ${gatewayMappingsTable}
				(config_key, name, backend, sort_order)
			SELECT config_key, name, backend, sort_order
			FROM deduped
			ON CONFLICT (config_key, name) DO UPDATE SET
				backend = EXCLUDED.backend,
				sort_order = EXCLUDED.sort_order,
				updated_at = now()
		`);
	}

	if (hasAllowedOrigins || hasMappings) {
		await pool.query(`
			ALTER TABLE ${gatewayConfigTable}
				DROP COLUMN IF EXISTS allowed_origins,
				DROP COLUMN IF EXISTS mappings
		`);
	}
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
			SELECT
				c.default_backend,
				COALESCE(o.allowed_origins, '[]'::jsonb) AS allowed_origins,
				COALESCE(m.mappings, '[]'::jsonb) AS mappings
			FROM ${gatewayConfigTable} c
			LEFT JOIN LATERAL (
				SELECT jsonb_agg(origin ORDER BY sort_order, origin) AS allowed_origins
				FROM ${gatewayAllowedOriginsTable}
				WHERE config_key = c.config_key
			) o ON true
			LEFT JOIN LATERAL (
				SELECT jsonb_agg(
					jsonb_build_object('name', name, 'backend', backend)
					ORDER BY sort_order, name
				) AS mappings
				FROM ${gatewayMappingsTable}
				WHERE config_key = c.config_key
			) m ON true
			WHERE c.config_key = $1
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

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await client.query(
			`
				INSERT INTO ${gatewayConfigTable}
					(config_key, default_backend)
				VALUES ($1, $2)
				ON CONFLICT (config_key) DO UPDATE SET
					default_backend = EXCLUDED.default_backend,
					updated_at = now()
				RETURNING default_backend
			`,
			[ACTIVE_CONFIG_KEY, cfg.defaultBackend]
		);

		await client.query(
			`DELETE FROM ${gatewayAllowedOriginsTable} WHERE config_key = $1`,
			[ACTIVE_CONFIG_KEY]
		);
		await client.query(
			`DELETE FROM ${gatewayMappingsTable} WHERE config_key = $1`,
			[ACTIVE_CONFIG_KEY]
		);

		await client.query(
			`
				INSERT INTO ${gatewayAllowedOriginsTable}
					(config_key, origin, sort_order)
				SELECT $1, o.origin, (o.ordinality - 1)::integer
				FROM jsonb_array_elements_text($2::jsonb)
					WITH ORDINALITY AS o(origin, ordinality)
			`,
			[ACTIVE_CONFIG_KEY, JSON.stringify(cfg.allowedOrigins || [])]
		);
		await client.query(
			`
				INSERT INTO ${gatewayMappingsTable}
					(config_key, name, backend, sort_order)
				SELECT $1, m.name, m.backend, m.sort_order
				FROM jsonb_to_recordset($2::jsonb)
					AS m(name text, backend text, sort_order integer)
			`,
			[
				ACTIVE_CONFIG_KEY,
				JSON.stringify(
					(cfg.mappings || []).map((mapping, index) => ({
						...mapping,
						sort_order: index,
					}))
				),
			]
		);

		await client.query("COMMIT");

		return rowToConfig({
			default_backend: result.rows[0].default_backend,
			allowed_origins: cfg.allowedOrigins || [],
			mappings: cfg.mappings || [],
		});
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ err: rollbackErr }, "Config transaction rollback failed");
		}
		throw err;
	} finally {
		client.release();
	}
}
