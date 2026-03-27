import { randomBytes } from "node:crypto";

export interface TokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
}

export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export class ApiTokenManager {
  private constructor(
    private readonly store: TokenStore,
    private currentToken: string,
  ) {}

  static async initialize(store: TokenStore): Promise<ApiTokenManager> {
    const existing = await store.getToken();
    if (existing) {
      return new ApiTokenManager(store, existing);
    }

    const seeded = generateSecureToken();
    await store.setToken(seeded);
    return new ApiTokenManager(store, seeded);
  }

  async getToken(): Promise<string> {
    return this.currentToken;
  }

  async rotateToken(): Promise<string> {
    const nextToken = generateSecureToken();
    await this.store.setToken(nextToken);
    this.currentToken = nextToken;
    return nextToken;
  }
}
