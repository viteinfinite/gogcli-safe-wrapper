import { describe, expect, it } from "bun:test";
import { ScopedTokenManager } from "./scoped-token-manager";
import type { GogPolicy } from "./gog-policy";

class InMemoryRegistryStore {
  constructor(public payload: string | null = null) {}
  async getRegistryPayload(): Promise<string | null> {
    return this.payload;
  }
  async setRegistryPayload(payload: string): Promise<void> {
    this.payload = payload;
  }
}

class TestPolicy implements GogPolicy {
  resolveAccess() {
    return { kind: "unknown", reason: "not used in these tests" } as const;
  }

  parseScopeSpec(spec: string): { scopeMap: Record<string, "READ" | "SAFE_WRITE" | "FULL_WRITE">; normalizedSpec: string } {
    const scopeMap: Record<string, "READ" | "SAFE_WRITE" | "FULL_WRITE"> = {};
    for (const entry of spec.split(",")) {
      const [rawKey, rawScope] = entry.split(":");
      if (!rawKey || !rawScope) {
        throw new Error("invalid scope spec");
      }
      const key = rawKey.trim().toLowerCase();
      const scope = rawScope.trim().toUpperCase();
      if (scope !== "READ" && scope !== "SAFE_WRITE" && scope !== "FULL_WRITE") {
        throw new Error("invalid scope");
      }
      scopeMap[key] = scope;
    }
    const normalizedSpec = Object.entries(scopeMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, scope]) => `${key}:${scope}`)
      .join(",");
    return { scopeMap, normalizedSpec };
  }

  allScopedTopLevels(): string[] {
    return ["calendar", "drive", "gmail"];
  }
}

describe("ScopedTokenManager", () => {
  it("migrates legacy token into default scoped token", async () => {
    const store = new InMemoryRegistryStore(null);
    const manager = await ScopedTokenManager.initialize(store, new TestPolicy(), "legacy-token-value");
    const resolved = await manager.resolveBearerToken("legacy-token-value");
    expect(resolved).not.toBeNull();
    expect(resolved?.tokenId).toBe("default");
    expect(resolved?.scopeSpec).toBe("calendar:FULL_WRITE,drive:FULL_WRITE,gmail:FULL_WRITE");
  });

  it("creates and rotates scoped tokens", async () => {
    const store = new InMemoryRegistryStore(null);
    const manager = await ScopedTokenManager.initialize(store, new TestPolicy(), null);

    const created = await manager.createToken("gmail:SAFE_WRITE");
    expect(created.tokenId.startsWith("tok_")).toBeTrue();
    expect(created.scopeSpec).toBe("gmail:SAFE_WRITE");

    const resolvedCreated = await manager.resolveBearerToken(created.token);
    expect(resolvedCreated?.tokenId).toBe(created.tokenId);

    const rotated = await manager.rotateToken(created.tokenId, "gmail:FULL_WRITE");
    expect(rotated.scopeSpec).toBe("gmail:FULL_WRITE");

    const oldResolved = await manager.resolveBearerToken(created.token);
    expect(oldResolved).toBeNull();
    const newResolved = await manager.resolveBearerToken(rotated.token);
    expect(newResolved?.scopeSpec).toBe("gmail:FULL_WRITE");
  });

  it("revokes tokens", async () => {
    const store = new InMemoryRegistryStore(null);
    const manager = await ScopedTokenManager.initialize(store, new TestPolicy(), null);
    const created = await manager.createToken("gmail:SAFE_WRITE");

    await manager.revokeToken(created.tokenId);
    const resolved = await manager.resolveBearerToken(created.token);
    expect(resolved).toBeNull();
  });
});

