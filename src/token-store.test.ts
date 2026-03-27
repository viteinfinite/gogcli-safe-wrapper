import { describe, expect, it } from "bun:test";
import { ApiTokenManager, type TokenStore } from "./token-store";

class InMemoryTokenStore implements TokenStore {
  constructor(private token: string | null) {}

  async getToken(): Promise<string | null> {
    return this.token;
  }

  async setToken(token: string): Promise<void> {
    this.token = token;
  }
}

describe("ApiTokenManager", () => {
  it("reuses existing token from store", async () => {
    const manager = await ApiTokenManager.initialize(new InMemoryTokenStore("existing"));
    expect(await manager.getToken()).toBe("existing");
  });

  it("seeds missing token and rotates", async () => {
    const store = new InMemoryTokenStore(null);
    const manager = await ApiTokenManager.initialize(store);
    const firstToken = await manager.getToken();
    expect(firstToken.length).toBeGreaterThan(0);

    const rotated = await manager.rotateToken();
    expect(rotated).not.toBe(firstToken);
    expect(await manager.getToken()).toBe(rotated);
    expect(await store.getToken()).toBe(rotated);
  });
});
