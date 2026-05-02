import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => {
  const activeRow = { value: null };
  const legacyColumns = new Set();
  const queryLog = [];
  const clientLog = [];

  const client = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql);
      clientLog.push({ sql: text, params });
      if (text.includes("RETURNING default_backend")) {
        return { rows: [{ default_backend: params[1] }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql);
      queryLog.push({ sql: text, params });
      if (text.includes("information_schema.columns")) {
        return { rows: [{ exists: legacyColumns.has(params[1]) }] };
      }
      if (text.includes("c.default_backend")) {
        return { rows: activeRow.value ? [activeRow.value] : [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => client),
  };

  return {
    activeRow,
    client,
    clientLog,
    legacyColumns,
    pool,
    queryLog,
    reset() {
      activeRow.value = null;
      legacyColumns.clear();
      queryLog.length = 0;
      clientLog.length = 0;
      pool.query.mockClear();
      pool.connect.mockClear();
      client.query.mockClear();
      client.release.mockClear();
    },
  };
});

vi.mock("../src/config/index.js", () => ({
  default: {
    database: { bootstrapConfigPath: null },
  },
}));

vi.mock("../src/db/postgres.js", () => ({
  dbSchema: "api_gateway",
  ensureDatabaseSchema: vi.fn(async () => {}),
  gatewayAllowedOriginsTable: '"api_gateway"."api_gateway_allowed_origins"',
  gatewayConfigTable: '"api_gateway"."api_gateway_config"',
  gatewayMappingsTable: '"api_gateway"."api_gateway_mappings"',
  pool: dbMocks.pool,
}));

vi.mock("../src/utils/logger.js", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function loadStore() {
  vi.resetModules();
  return import("../src/config/postgresConfigStore.js");
}

describe("postgresConfigStore", () => {
  beforeEach(() => {
    dbMocks.reset();
  });

  it("creates normalized config tables and migrates legacy json columns", async () => {
    dbMocks.legacyColumns.add("allowed_origins");
    dbMocks.legacyColumns.add("mappings");
    dbMocks.activeRow.value = {
      default_backend: "http://fallback:9999",
      allowed_origins: ["https://frontend.example.com"],
      mappings: [{ name: "app", backend: "http://backend:3000" }],
    };

    const store = await loadStore();
    const cfg = await store.readConfigFromStore();

    expect(cfg).toEqual({
      defaultBackend: "http://fallback:9999",
      allowedOrigins: ["https://frontend.example.com"],
      mappings: [{ name: "app", backend: "http://backend:3000" }],
    });

    const configCreate = dbMocks.queryLog.find(({ sql }) =>
      sql.includes('CREATE TABLE IF NOT EXISTS "api_gateway"."api_gateway_config"')
    )?.sql;
    expect(configCreate).toBeTruthy();
    expect(configCreate).not.toMatch(/allowed_origins jsonb|mappings jsonb/);

    const allSql = dbMocks.queryLog.map(({ sql }) => sql).join("\n");
    expect(allSql).toContain(
      'CREATE TABLE IF NOT EXISTS "api_gateway"."api_gateway_allowed_origins"'
    );
    expect(allSql).toContain(
      'CREATE TABLE IF NOT EXISTS "api_gateway"."api_gateway_mappings"'
    );
    expect(allSql).toContain('INSERT INTO "api_gateway"."api_gateway_allowed_origins"');
    expect(allSql).toContain('INSERT INTO "api_gateway"."api_gateway_mappings"');
    expect(allSql).toContain("DROP COLUMN IF EXISTS allowed_origins");
    expect(allSql).toContain("DROP COLUMN IF EXISTS mappings");
  });

  it("writes scalar config and replaces child rows transactionally", async () => {
    const store = await loadStore();

    const cfg = await store.writeConfigToStore({
      defaultBackend: "http://fallback:9999",
      allowedOrigins: ["https://frontend.example.com"],
      mappings: [{ name: "app", backend: "http://backend:3000" }],
    });

    expect(cfg).toEqual({
      defaultBackend: "http://fallback:9999",
      allowedOrigins: ["https://frontend.example.com"],
      mappings: [{ name: "app", backend: "http://backend:3000" }],
    });

    expect(dbMocks.clientLog[0].sql).toBe("BEGIN");
    expect(dbMocks.clientLog.at(-1).sql).toBe("COMMIT");
    expect(dbMocks.client.release).toHaveBeenCalledOnce();

    const configInsert = dbMocks.clientLog.find(({ sql }) =>
      sql.includes('INSERT INTO "api_gateway"."api_gateway_config"')
    );
    expect(configInsert.sql).not.toMatch(/allowed_origins|mappings/);

    const originsInsert = dbMocks.clientLog.find(({ sql }) =>
      sql.includes('INSERT INTO "api_gateway"."api_gateway_allowed_origins"')
    );
    expect(JSON.parse(originsInsert.params[1])).toEqual([
      "https://frontend.example.com",
    ]);

    const mappingsInsert = dbMocks.clientLog.find(({ sql }) =>
      sql.includes('INSERT INTO "api_gateway"."api_gateway_mappings"')
    );
    expect(JSON.parse(mappingsInsert.params[1])).toEqual([
      { name: "app", backend: "http://backend:3000", sort_order: 0 },
    ]);
  });
});
