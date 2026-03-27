import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, LinuxSecretStore, MacOSKeychainSecretStore } from "./secret-store";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
  tempDirs = [];
});

describe("createSecretStore", () => {
  it("creates a macOS keychain store on darwin", () => {
    const store = createSecretStore("darwin", {
      service: "svc",
      linuxFallbackPath: "/tmp/unused.json",
    });
    expect(store).toBeInstanceOf(MacOSKeychainSecretStore);
  });

  it("creates a linux store on linux", () => {
    const store = createSecretStore("linux", {
      service: "svc",
      linuxFallbackPath: "/tmp/secrets.json",
    });
    expect(store).toBeInstanceOf(LinuxSecretStore);
  });
});

describe("LinuxSecretStore fallback behavior", () => {
  it("falls back to file storage when native backend fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gws-sec-wrapper-"));
    tempDirs.push(dir);
    const fallbackPath = join(dir, "secrets.json");

    const store = new LinuxSecretStore("svc", fallbackPath, {
      nativeBackend: {
        async getPassword(): Promise<string | null> {
          throw new Error("native unavailable");
        },
        async setPassword(): Promise<void> {
          throw new Error("native unavailable");
        },
      },
    });

    await store.setSecret("admin-token", "secret-value");
    const value = await store.getSecret("admin-token");
    expect(value).toBe("secret-value");

    const file = await readFile(fallbackPath, "utf8");
    expect(file).toContain("secret-value");
  });

  it("uses native backend when available", async () => {
    const store = new LinuxSecretStore("svc", "/tmp/unused.json", {
      nativeBackend: {
        async getPassword(service: string, account: string): Promise<string | null> {
          if (service === "svc" && account === "admin-token") {
            return "native-secret";
          }
          return null;
        },
        async setPassword(): Promise<void> {
          return;
        },
      },
    });

    expect(await store.getSecret("admin-token")).toBe("native-secret");
  });
});
