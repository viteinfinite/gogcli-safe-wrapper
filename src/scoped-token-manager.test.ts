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

  parseScopeSpec(spec: string): { allowMap: Record<string, true>; normalizedSpec: string } {
    const allowMap: Record<string, true> = {};
    for (const entry of spec.split(",")) {
      const normalized = entry.trim().toLowerCase();
      if (!normalized) {
        throw new Error("invalid scope spec");
      }
      allowMap[normalized] = true;
    }
    const normalizedSpec = Object.keys(allowMap)
      .sort((a, b) => a.localeCompare(b))
      .join(",");
    return { allowMap, normalizedSpec };
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
    expect(resolved?.scopeSpec).toBe("calendar,drive,gmail");
  });

  it("creates and rotates scoped tokens", async () => {
    const store = new InMemoryRegistryStore(null);
    const manager = await ScopedTokenManager.initialize(store, new TestPolicy(), null);

    const created = await manager.createToken("gmail:drafts");
    expect(created.tokenId.startsWith("tok_")).toBeTrue();
    expect(created.scopeSpec).toBe("gmail:drafts");

    const resolvedCreated = await manager.resolveBearerToken(created.token);
    expect(resolvedCreated?.tokenId).toBe(created.tokenId);

    const rotated = await manager.rotateToken(created.tokenId, "gmail");
    expect(rotated.scopeSpec).toBe("gmail");

    const oldResolved = await manager.resolveBearerToken(created.token);
    expect(oldResolved).toBeNull();
    const newResolved = await manager.resolveBearerToken(rotated.token);
    expect(newResolved?.scopeSpec).toBe("gmail");
  });

  it("revokes tokens", async () => {
    const store = new InMemoryRegistryStore(null);
    const manager = await ScopedTokenManager.initialize(store, new TestPolicy(), null);
    const created = await manager.createToken("gmail:drafts");

    await manager.revokeToken(created.tokenId);
    const resolved = await manager.resolveBearerToken(created.token);
    expect(resolved).toBeNull();
  });
});
