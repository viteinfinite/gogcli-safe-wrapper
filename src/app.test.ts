import { describe, expect, it } from "bun:test";
import { createApp, type ScopedTokenManager } from "./app";
import type { CommandRunResult, CommandRunner } from "./command-runner";
import type { AccessRequirement, GogPolicy } from "./gog-policy";

class FakeRunner implements CommandRunner {
  public calls: string[][] = [];
  constructor(private nextResult: CommandRunResult = { output: "ok\n", exitCode: 0 }) {}

  async run(argv: string[]): Promise<CommandRunResult> {
    this.calls.push(argv);
    return this.nextResult;
  }
}

class FakeTokenManager implements ScopedTokenManager {
  private readonly tokenByBearer = new Map<string, { tokenId: string; scopeSpec: string; allows: Record<string, true> }>();
  private readonly metadata = new Map<string, { tokenId: string; scopeSpec: string; createdAt: string; updatedAt: string; revokedAt?: string }>();

  constructor() {
    const now = "2026-03-28T00:00:00.000Z";
    this.tokenByBearer.set("good-safe", {
      tokenId: "tok_safe",
      scopeSpec: "gmail:drafts",
      allows: { "gmail:drafts": true },
    });
    this.tokenByBearer.set("good-read", {
      tokenId: "tok_read",
      scopeSpec: "gmail:search",
      allows: { "gmail:search": true },
    });
    this.tokenByBearer.set("good-full", {
      tokenId: "tok_full",
      scopeSpec: "gmail",
      allows: { gmail: true },
    });
    this.metadata.set("tok_safe", { tokenId: "tok_safe", scopeSpec: "gmail:drafts", createdAt: now, updatedAt: now });
  }

  async createToken(scopeSpec: string) {
    const tokenId = "tok_created";
    const token = "created-token";
    const now = "2026-03-28T01:00:00.000Z";
    this.tokenByBearer.set(token, { tokenId, scopeSpec, allows: { "gmail:drafts": true } });
    this.metadata.set(tokenId, { tokenId, scopeSpec, createdAt: now, updatedAt: now });
    return { tokenId, token, scopeSpec, createdAt: now, updatedAt: now };
  }

  async rotateToken(tokenId: string, scopeSpec?: string) {
    if (!this.metadata.get(tokenId)) {
      throw new Error("token not found");
    }
    const token = "rotated-token";
    const now = "2026-03-28T02:00:00.000Z";
    const nextScopeSpec = scopeSpec ?? "gmail:drafts";
    this.tokenByBearer.set(token, { tokenId, scopeSpec: nextScopeSpec, allows: { "gmail:drafts": true } });
    this.metadata.set(tokenId, {
      tokenId,
      scopeSpec: nextScopeSpec,
      createdAt: now,
      updatedAt: now,
    });
    return { tokenId, token, scopeSpec: nextScopeSpec, createdAt: now, updatedAt: now };
  }

  async revokeToken(tokenId: string): Promise<void> {
    const metadata = this.metadata.get(tokenId);
    if (!metadata) {
      throw new Error("token not found");
    }
    metadata.revokedAt = "2026-03-28T03:00:00.000Z";
  }

  async listTokens() {
    return [...this.metadata.values()];
  }

  async resolveBearerToken(token: string) {
    return this.tokenByBearer.get(token) ?? null;
  }
}

class FakePolicy implements GogPolicy {
  parseScopeSpec(spec: string) {
    return {
      allowMap: { [spec.trim()]: true } as Record<string, true>,
      normalizedSpec: spec.trim(),
    };
  }

  allScopedTopLevels() {
    return ["gmail", "calendar", "drive"];
  }

  resolveAccess(argv: string[]): AccessRequirement {
    if (argv[0] === "auth") {
      return { kind: "admin", canonicalCommand: "auth status", topLevel: "auth" };
    }
    if (argv[0] === "gmail" && argv[1] === "drafts" && argv[2] === "send") {
      return {
        kind: "scoped",
        canonicalCommand: "gmail drafts send",
        topLevel: "gmail",
        allowEntries: ["gmail", "gmail:drafts"],
      };
    }
    if (argv[0] === "gmail") {
      return {
        kind: "scoped",
        canonicalCommand: "gmail search",
        topLevel: "gmail",
        allowEntries: ["gmail", "gmail:search"],
      };
    }
    return { kind: "unknown", reason: "unrecognized command" };
  }
}

function buildApp() {
  const tokenManager = new FakeTokenManager();
  const runner = new FakeRunner();
  const app = createApp({
    adminToken: "admin-token",
    tokenManager,
    commandRunner: runner,
    policy: new FakePolicy(),
  });
  return { app, tokenManager, runner };
}

describe("admin token endpoints", () => {
  it("requires admin token for rotate", async () => {
    const { app } = buildApp();
    const response = await app.fetch(new Request("http://localhost/auth/rotate", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("creates token on rotate when scopeSpec provided without tokenId", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/auth/rotate", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopeSpec: "gmail:drafts" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string; tokenId: string; token: string };
    expect(body.mode).toBe("created");
    expect(body.tokenId).toBe("tok_created");
    expect(body.token).toBe("created-token");
  });

  it("rotates token by tokenId", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/auth/rotate", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tokenId: "tok_safe" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string; token: string };
    expect(body.mode).toBe("rotated");
    expect(body.token).toBe("rotated-token");
  });

  it("lists and revokes tokens with admin auth", async () => {
    const { app } = buildApp();
    const listResponse = await app.fetch(
      new Request("http://localhost/auth/tokens", {
        method: "GET",
        headers: { "X-Admin-Token": "admin-token" },
      }),
    );
    expect(listResponse.status).toBe(200);

    const revokeResponse = await app.fetch(
      new Request("http://localhost/auth/tokens/revoke", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tokenId: "tok_safe" }),
      }),
    );
    expect(revokeResponse.status).toBe(200);
  });
});

describe("POST /api auth and scopes", () => {
  it("requires admin token for auth* commands", async () => {
    const { app, runner } = buildApp();
    const denied = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ subcommand: "auth status --plain" }),
      }),
    );
    expect(denied.status).toBe(401);

    const allowed = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
        },
        body: JSON.stringify({ subcommand: "auth status --plain" }),
      }),
    );
    expect(allowed.status).toBe(200);
    expect(runner.calls).toEqual([["auth", "status", "--plain"]]);
  });

  it("requires bearer token for non-auth commands", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ subcommand: "gmail drafts create --subject hi" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("enforces allowlist entries for non-auth commands", async () => {
    const { app } = buildApp();

    const denied = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer good-read",
        },
        body: JSON.stringify({ subcommand: "gmail drafts send --id x" }),
      }),
    );
    expect(denied.status).toBe(403);

    const allowed = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer good-full",
        },
        body: JSON.stringify({ subcommand: "gmail drafts send --id x" }),
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it("denies commands unknown to scope policy", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer good-full",
        },
        body: JSON.stringify({ subcommand: "totally-unknown command" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects disallowed metacharacters", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer good-safe",
        },
        body: JSON.stringify({ subcommand: "gmail drafts create; whoami" }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
