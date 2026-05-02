import { describe, it, expect, vi, beforeEach } from "vitest";

const storeMocks = vi.hoisted(() => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const defaultConfig = {
    defaultBackend: "fallback:9999",
    allowedOrigins: ["https://from-db.example.com"],
    mappings: [{ name: "Authentic Tracker!", backend: "backend:3000" }],
  };
  const state = { config: clone(defaultConfig) };

  return {
    defaultConfig,
    state,
    readConfigFromStore: vi.fn(async () => clone(state.config)),
    writeConfigToStore: vi.fn(async (cfg) => {
      state.config = clone(cfg);
      return clone(state.config);
    }),
  };
});

vi.mock("../src/config/index.js", () => ({
  default: {
    allowedOrigins: ["https://from-env.example.com"],
  },
}));

vi.mock("../src/config/postgresConfigStore.js", () => ({
  readConfigFromStore: (...args) => storeMocks.readConfigFromStore(...args),
  writeConfigToStore: (...args) => storeMocks.writeConfigToStore(...args),
}));

async function loadProxyConfig() {
  vi.resetModules();
  return import("../src/config/proxyConfig.js");
}

describe("proxyConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.state.config = JSON.parse(JSON.stringify(storeMocks.defaultConfig));
  });

  it("loads and normalizes config from Postgres, merging env allowed origins", async () => {
    const {
      defaultBackend,
      mappings,
      allowedOrigins,
      allowedFrontendHosts,
    } = await loadProxyConfig();

    expect(defaultBackend).toBe("http://fallback:9999");
    expect(mappings).toEqual([
      { name: "authentictracker", backend: "http://backend:3000" },
    ]);

    expect(allowedOrigins).toContain("https://from-db.example.com");
    expect(allowedOrigins).toContain("https://from-env.example.com");
    expect(Array.isArray(allowedFrontendHosts)).toBe(true);
  });

  it("writes to Postgres and hot-refreshes the live bindings", async () => {
    const proxyConfig = await loadProxyConfig();

    await proxyConfig.writeAndReloadConfig({
      defaultBackend: "new-fallback:8080",
      allowedOrigins: ["https://new.example.com/path"],
      mappings: [{ name: "New App", backend: "new-backend:3000" }],
    });

    expect(storeMocks.writeConfigToStore).toHaveBeenCalledWith({
      defaultBackend: "http://new-fallback:8080",
      allowedOrigins: ["https://new.example.com"],
      mappings: [{ name: "newapp", backend: "http://new-backend:3000" }],
    });
    expect(proxyConfig.getDefaultBackend()).toBe("http://new-fallback:8080");
    expect(proxyConfig.getMappings()).toEqual([
      { name: "newapp", backend: "http://new-backend:3000" },
    ]);
    expect(proxyConfig.getAllowedOrigins()).toContain("https://new.example.com");
  });

  it("rejects invalid mapping rows", async () => {
    const proxyConfig = await loadProxyConfig();

    await expect(
      proxyConfig.writeAndReloadConfig({
        defaultBackend: "http://fallback:9999",
        allowedOrigins: [],
        mappings: [{ name: "", backend: "http://backend:3000" }],
      })
    ).rejects.toThrow(/name and backend/);
  });

  it("rejects duplicate mapping names after normalization", async () => {
    const proxyConfig = await loadProxyConfig();

    await expect(
      proxyConfig.writeAndReloadConfig({
        defaultBackend: "http://fallback:9999",
        allowedOrigins: [],
        mappings: [
          { name: "New App", backend: "http://backend:3000" },
          { name: "newapp", backend: "http://other-backend:3000" },
        ],
      })
    ).rejects.toThrow(/Duplicate mapping name: newapp/);
  });
});
