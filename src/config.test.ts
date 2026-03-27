import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("loads defaults on darwin", () => {
    const config = loadConfig(
      {},
      "darwin",
    );

    expect(config.port).toBe(3000);
    expect(config.gogBin).toBe("gog");
    expect(config.secretService).toBe("gws-security-wrapper");
    expect(config.apiTokenAccount).toBe("api-token");
    expect(config.adminTokenAccount).toBe("admin-token");
    expect(config.linuxFallbackPath).toBe("~/.config/gws-security-wrapper/secrets.json");
  });

  it("loads linux config with fallback path", () => {
    const config = loadConfig({}, "linux");
    expect(config.platform).toBe("linux");
    expect(config.linuxFallbackPath).toBe("~/.config/gws-security-wrapper/secrets.json");
  });
});
