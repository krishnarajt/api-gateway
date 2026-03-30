import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import yaml from "js-yaml";

// Mock config/index.js (loaded by proxyConfig)
vi.mock("../src/config/index.js", () => ({
  default: {
    allowedOrigins: ["https://from-env.example.com"],
    redisUrl: "redis://localhost:6379",
  },
}));

describe("proxyConfig", () => {
  it("loads and normalizes config.yml, merges allowedOrigins", async () => {
    // Read the actual config.yml to know what to expect
    const raw = fs.readFileSync("config.yml", "utf8");
    const cfg = yaml.load(raw);

    const {
      defaultBackend,
      mappings,
      allowedOrigins,
      allowedFrontendHosts,
    } = await import("../src/config/proxyConfig.js");

    expect(defaultBackend).toBe(cfg.defaultBackend);
    expect(mappings.length).toBe(cfg.mappings.length);

    // Each mapping should have normalized frontendHost
    for (const m of mappings) {
      expect(m.frontendHost).toBe(m.frontendHost.toLowerCase());
      expect(m).toHaveProperty("frontendPort");
      expect(m).toHaveProperty("pathPrefix");
      expect(m).toHaveProperty("backend");
    }

    // allowedOrigins should merge config.yml + env
    expect(allowedOrigins).toContain("https://from-env.example.com");
    if (cfg.allowedOrigins) {
      for (const o of cfg.allowedOrigins) {
        expect(allowedOrigins).toContain(o);
      }
    }

    // allowedFrontendHosts should be derived from allowedOrigins
    expect(Array.isArray(allowedFrontendHosts)).toBe(true);
  });

  it("backend URLs in mappings have a scheme", async () => {
    const { mappings } = await import("../src/config/proxyConfig.js");
    for (const m of mappings) {
      if (m.backend) {
        expect(m.backend).toMatch(/^https?:\/\//);
      }
    }
  });
});
