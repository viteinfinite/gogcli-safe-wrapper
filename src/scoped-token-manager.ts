import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GogPolicy } from "./gog-policy";

interface ScopedTokenRecord {
  tokenId: string;
  tokenHash: string;
  scopeSpec: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

interface TokenRegistry {
  version: 1;
  tokens: ScopedTokenRecord[];
}

interface ScopedTokenStore {
  getRegistryPayload(): Promise<string | null>;
  setRegistryPayload(payload: string): Promise<void>;
}

export interface ScopedTokenMetadata {
  tokenId: string;
  scopeSpec: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface IssuedScopedToken extends ScopedTokenMetadata {
  token: string;
}

export interface ResolvedScopedToken {
  tokenId: string;
  scopeSpec: string;
  allows: Record<string, true>;
}

export class ScopedTokenManager {
  private constructor(
    private readonly store: ScopedTokenStore,
    private readonly policy: GogPolicy,
    private registry: TokenRegistry,
  ) {}

  static async initialize(
    store: ScopedTokenStore,
    policy: GogPolicy,
    legacyToken: string | null,
  ): Promise<ScopedTokenManager> {
    const existingPayload = await store.getRegistryPayload();
    if (existingPayload) {
      try {
        const registry = parseRegistryPayload(existingPayload);
        return new ScopedTokenManager(store, policy, registry);
      } catch {
        // Legacy storage format: raw token string.
      }
    }

    const manager = new ScopedTokenManager(store, policy, { version: 1, tokens: [] });
    const seedToken = legacyToken && legacyToken.trim() ? legacyToken : existingPayload;
    if (seedToken && seedToken.trim()) {
      const legacyScopeSpec = policy
        .allScopedTopLevels()
        .map((key) => key)
        .join(",");
      await manager.createTokenInternal(legacyScopeSpec, "default", seedToken);
    }
    await manager.persist();
    return manager;
  }

  async createToken(scopeSpec: string): Promise<IssuedScopedToken> {
    return await this.createTokenInternal(scopeSpec);
  }

  async rotateToken(tokenId: string, scopeSpec?: string): Promise<IssuedScopedToken> {
    const record = this.registry.tokens.find((token) => token.tokenId === tokenId && !token.revokedAt);
    if (!record) {
      throw new Error(`tokenId '${tokenId}' not found or revoked`);
    }

    const nextScopeSpec = scopeSpec ? this.policy.parseScopeSpec(scopeSpec).normalizedSpec : record.scopeSpec;
    const now = new Date().toISOString();
    const token = generateSecureToken();

    record.scopeSpec = nextScopeSpec;
    record.tokenHash = hashToken(token);
    record.updatedAt = now;

    await this.persist();
    return {
      tokenId: record.tokenId,
      token,
      scopeSpec: record.scopeSpec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revokedAt: record.revokedAt,
    };
  }

  async revokeToken(tokenId: string): Promise<void> {
    const record = this.registry.tokens.find((token) => token.tokenId === tokenId && !token.revokedAt);
    if (!record) {
      throw new Error(`tokenId '${tokenId}' not found or already revoked`);
    }

    const now = new Date().toISOString();
    record.revokedAt = now;
    record.updatedAt = now;
    await this.persist();
  }

  async listTokens(): Promise<ScopedTokenMetadata[]> {
    return this.registry.tokens.map((token) => ({
      tokenId: token.tokenId,
      scopeSpec: token.scopeSpec,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
      revokedAt: token.revokedAt,
    }));
  }

  async resolveBearerToken(token: string): Promise<ResolvedScopedToken | null> {
    const hashed = hashToken(token);
    const record = this.registry.tokens.find((candidate) => {
      if (candidate.revokedAt) {
        return false;
      }
      return secureEquals(candidate.tokenHash, hashed);
    });
    if (!record) {
      return null;
    }

    let parsed: ReturnType<GogPolicy["parseScopeSpec"]>;
    try {
      parsed = this.policy.parseScopeSpec(record.scopeSpec);
    } catch {
      // Fail closed for legacy/invalid specs.
      return null;
    }
    return {
      tokenId: record.tokenId,
      scopeSpec: parsed.normalizedSpec,
      allows: parsed.allowMap,
    };
  }

  private async createTokenInternal(
    scopeSpec: string,
    forcedTokenId?: string,
    forcedTokenValue?: string,
  ): Promise<IssuedScopedToken> {
    const parsed = this.policy.parseScopeSpec(scopeSpec);
    const tokenId = forcedTokenId ?? generateTokenId();
    if (this.registry.tokens.some((token) => token.tokenId === tokenId)) {
      throw new Error(`tokenId '${tokenId}' already exists`);
    }

    const token = forcedTokenValue ?? generateSecureToken();
    const now = new Date().toISOString();
    const record: ScopedTokenRecord = {
      tokenId,
      tokenHash: hashToken(token),
      scopeSpec: parsed.normalizedSpec,
      createdAt: now,
      updatedAt: now,
    };
    this.registry.tokens.push(record);
    await this.persist();

    return {
      tokenId: record.tokenId,
      token,
      scopeSpec: record.scopeSpec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(
      {
        version: 1,
        tokens: this.registry.tokens
          .map((token) => ({
            tokenId: token.tokenId,
            tokenHash: token.tokenHash,
            scopeSpec: normalizeScopeSpec(token.scopeSpec),
            createdAt: token.createdAt,
            updatedAt: token.updatedAt,
            revokedAt: token.revokedAt,
          }))
          .sort((a, b) => a.tokenId.localeCompare(b.tokenId)),
      } satisfies TokenRegistry,
      null,
      2,
    );
    await this.store.setRegistryPayload(payload);
  }
}

function parseRegistryPayload(payload: string): TokenRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid scoped token registry JSON payload");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid scoped token registry payload");
  }

  const registry = parsed as {
    version?: unknown;
    tokens?: unknown;
  };
  if (registry.version !== 1 || !Array.isArray(registry.tokens)) {
    throw new Error("Unsupported scoped token registry format");
  }

  const tokens: ScopedTokenRecord[] = registry.tokens.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid token record in registry");
    }
    const record = value as Record<string, unknown>;
    const tokenId = asString(record.tokenId, "tokenId");
    const tokenHash = asString(record.tokenHash, "tokenHash");
    const scopeSpec = asString(record.scopeSpec, "scopeSpec");
    const createdAt = asString(record.createdAt, "createdAt");
    const updatedAt = asString(record.updatedAt, "updatedAt");
    const revokedAt = record.revokedAt === undefined ? undefined : asString(record.revokedAt, "revokedAt");
    return {
      tokenId,
      tokenHash,
      scopeSpec: normalizeScopeSpec(scopeSpec),
      createdAt,
      updatedAt,
      revokedAt,
    };
  });

  return {
    version: 1,
    tokens,
  };
}

function normalizeScopeSpec(spec: string): string {
  return Array.from(
    new Set(
      spec
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) =>
          entry
            .split(":")
            .map((part) => part.trim().toLowerCase())
            .join(":"),
        ),
    ),
  )
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

function generateTokenId(bytes = 8): string {
  return `tok_${randomBytes(bytes).toString("hex")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid '${fieldName}' in token registry`);
  }
  return value;
}
