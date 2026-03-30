import type { CommandRunner, CommandRunResult } from "./command-runner";
import type { GogPolicy } from "./gog-policy";
import { hasDisallowedMetacharacters, parseSubcommandToArgv } from "./argv";

const MAX_BATCH_SIZE = 10;

type BatchItem =
  | { kind: "run"; argv: string[] }
  | { kind: "error"; error: string; reason?: string };

export interface ScopedTokenManager {
  createToken(scopeSpec: string): Promise<{
    tokenId: string;
    token: string;
    scopeSpec: string;
    createdAt: string;
    updatedAt: string;
    revokedAt?: string;
  }>;
  rotateToken(
    tokenId: string,
    scopeSpec?: string,
  ): Promise<{
    tokenId: string;
    token: string;
    scopeSpec: string;
    createdAt: string;
    updatedAt: string;
    revokedAt?: string;
  }>;
  revokeToken(tokenId: string): Promise<void>;
  revokeAllTokens(): Promise<number>;
  listTokens(): Promise<
    Array<{
      tokenId: string;
      scopeSpec: string;
      createdAt: string;
      updatedAt: string;
      revokedAt?: string;
    }>
  >;
  resolveBearerToken(token: string): Promise<{
    tokenId: string;
    scopeSpec: string;
    allows: Record<string, true>;
  } | null>;
}

export interface AppDependencies {
  adminToken: string;
  commandRunner: CommandRunner;
  tokenManager: ScopedTokenManager;
  policy: GogPolicy;
}

export interface App {
  fetch(request: Request): Promise<Response>;
}

export function createApp(deps: AppDependencies): App {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(200, { status: "ok" });
      }

      if (request.method === "POST" && url.pathname === "/auth/rotate") {
        return await handleRotate(request, deps);
      }

      if (request.method === "GET" && url.pathname === "/auth/tokens") {
        return await handleListTokens(request, deps);
      }

      if (request.method === "POST" && url.pathname === "/auth/tokens/revoke") {
        return await handleRevokeToken(request, deps);
      }

      if (request.method === "POST" && url.pathname === "/auth/tokens/revoke-all") {
        return await handleRevokeAllTokens(request, deps);
      }

      if (request.method === "POST" && url.pathname === "/api") {
        return await handleApi(request, deps);
      }

      return jsonResponse(404, { error: "not_found" });
    },
  };
}

async function handleRotate(request: Request, deps: AppDependencies): Promise<Response> {
  const provided = request.headers.get("x-admin-token");
  if (!provided || provided !== deps.adminToken) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await parseOptionalJsonBody(request);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const tokenId = extractOptionalStringField(body, "tokenId");
  const scopeSpec = extractOptionalStringField(body, "scopeSpec");

  if (tokenId) {
    try {
      const issued = await deps.tokenManager.rotateToken(tokenId, scopeSpec ?? undefined);
      return jsonResponse(200, {
        mode: "rotated",
        tokenId: issued.tokenId,
        token: issued.token,
        scopeSpec: issued.scopeSpec,
        createdAt: issued.createdAt,
        updatedAt: issued.updatedAt,
        revokedAt: issued.revokedAt,
      });
    } catch (error) {
      return jsonResponse(400, { error: stringifyErrorMessage(error, "token_rotation_failed") });
    }
  }

  if (scopeSpec) {
    try {
      const issued = await deps.tokenManager.createToken(scopeSpec);
      return jsonResponse(200, {
        mode: "created",
        tokenId: issued.tokenId,
        token: issued.token,
        scopeSpec: issued.scopeSpec,
        createdAt: issued.createdAt,
        updatedAt: issued.updatedAt,
        revokedAt: issued.revokedAt,
      });
    } catch (error) {
      return jsonResponse(400, { error: stringifyErrorMessage(error, "token_creation_failed") });
    }
  }

  return jsonResponse(400, { error: "tokenId or scopeSpec is required" });
}

async function handleListTokens(request: Request, deps: AppDependencies): Promise<Response> {
  const provided = request.headers.get("x-admin-token");
  if (!provided || provided !== deps.adminToken) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const tokens = await deps.tokenManager.listTokens();
  return jsonResponse(200, { tokens });
}

async function handleRevokeToken(request: Request, deps: AppDependencies): Promise<Response> {
  const provided = request.headers.get("x-admin-token");
  if (!provided || provided !== deps.adminToken) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await parseOptionalJsonBody(request);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const tokenId = extractOptionalStringField(body, "tokenId");
  if (!tokenId) {
    return jsonResponse(400, { error: "tokenId is required" });
  }

  try {
    await deps.tokenManager.revokeToken(tokenId);
    return jsonResponse(200, { ok: true, tokenId });
  } catch (error) {
    return jsonResponse(400, { error: stringifyErrorMessage(error, "token_revoke_failed") });
  }
}

async function handleRevokeAllTokens(request: Request, deps: AppDependencies): Promise<Response> {
  const provided = request.headers.get("x-admin-token");
  if (!provided || provided !== deps.adminToken) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  try {
    const revoked = await deps.tokenManager.revokeAllTokens();
    return jsonResponse(200, { ok: true, revoked });
  } catch (error) {
    return jsonResponse(500, { error: stringifyErrorMessage(error, "token_revoke_all_failed") });
  }
}

async function handleApi(request: Request, deps: AppDependencies): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  // Single-command path (backward compatible)
  const subcommand = extractSubcommand(body);
  if (subcommand) {
    return handleSingleCommand(request, deps, subcommand);
  }

  // Batch path
  const subcommands = extractSubcommands(body);
  if (subcommands) {
    return handleBatchCommands(request, deps, subcommands);
  }

  return jsonResponse(400, { error: "subcommand or subcommands must be provided" });
}

async function handleSingleCommand(
  request: Request,
  deps: AppDependencies,
  subcommand: string,
): Promise<Response> {
  if (hasDisallowedMetacharacters(subcommand)) {
    return jsonResponse(400, { error: "subcommand contains disallowed metacharacters" });
  }

  let argv: string[];
  try {
    argv = parseSubcommandToArgv(subcommand);
  } catch (error) {
    return jsonResponse(400, { error: stringifyErrorMessage(error, "invalid_subcommand") });
  }

  const access = deps.policy.resolveAccess(argv);
  if (access.kind === "unknown") {
    return jsonResponse(403, { error: "forbidden_by_scope_policy", reason: access.reason });
  }

  const authError = await checkCommandAuth(request, deps, access);
  if (authError) {
    return authError;
  }

  try {
    const result = await deps.commandRunner.run(argv);
    return new Response(result.output, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    return jsonResponse(500, { error: stringifyErrorMessage(error, "execution_failed") });
  }
}

async function handleBatchCommands(
  request: Request,
  deps: AppDependencies,
  subcommands: string[],
): Promise<Response> {
  if (subcommands.length > MAX_BATCH_SIZE) {
    return jsonResponse(400, { error: `batch size exceeds maximum of ${MAX_BATCH_SIZE}` });
  }

  // Resolve auth once for all commands
  const bearer = extractBearerToken(request.headers.get("authorization"));
  const adminToken = request.headers.get("x-admin-token");
  const isAdmin = !!adminToken && adminToken === deps.adminToken;

  let resolvedToken: { allows: Record<string, true> } | null = null;
  if (!isAdmin && bearer) {
    resolvedToken = await deps.tokenManager.resolveBearerToken(bearer);
  }

  // Validate and authorize each command individually
  const items: BatchItem[] = subcommands.map((subcommand): BatchItem => {
    if (hasDisallowedMetacharacters(subcommand)) {
      return { kind: "error", error: "subcommand contains disallowed metacharacters" };
    }

    let argv: string[];
    try {
      argv = parseSubcommandToArgv(subcommand);
    } catch (error) {
      return { kind: "error", error: stringifyErrorMessage(error, "invalid_subcommand") };
    }

    const access = deps.policy.resolveAccess(argv);
    if (access.kind === "unknown") {
      return { kind: "error", error: "forbidden_by_scope_policy", reason: access.reason };
    }

    if (access.kind === "admin") {
      if (!isAdmin) {
        return { kind: "error", error: "unauthorized" };
      }
      return { kind: "run", argv };
    }

    // Scoped command
    if (!resolvedToken) {
      return { kind: "error", error: "unauthorized" };
    }

    const isAllowed = access.allowEntries.some((entry) => resolvedToken.allows[entry]);
    if (!isAllowed) {
      return {
        kind: "error",
        error: "forbidden_by_scope_policy",
        reason: `missing allowlist entry for '${access.canonicalCommand}' (expected one of: ${access.allowEntries.join(", ")})`,
      };
    }

    return { kind: "run", argv };
  });

  // Execute all valid commands in parallel
  const runPromises: Promise<CommandRunResult>[] = [];
  const runIndices: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "run") {
      runIndices.push(i);
      runPromises.push(deps.commandRunner.run(item.argv));
    }
  }

  const runResults = await Promise.all(runPromises);

  // Map results back to original order
  let runIdx = 0;
  const results: Record<string, unknown>[] = items.map((item) => {
    if (item.kind === "error") {
      const entry: Record<string, unknown> = { error: item.error };
      if (item.reason) entry.reason = item.reason;
      return entry;
    }
    const result = runResults[runIdx++];
    return { output: result.output, exitCode: result.exitCode };
  });

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function checkCommandAuth(
  request: Request,
  deps: AppDependencies,
  access: { kind: "admin" } | { kind: "scoped"; allowEntries: string[]; canonicalCommand: string },
): Promise<Response | null> {
  if (access.kind === "admin") {
    const providedAdminToken = request.headers.get("x-admin-token");
    if (!providedAdminToken || providedAdminToken !== deps.adminToken) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    return null;
  }

  const bearer = extractBearerToken(request.headers.get("authorization"));
  if (!bearer) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const resolvedToken = await deps.tokenManager.resolveBearerToken(bearer);
  if (!resolvedToken) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const isAllowed = access.allowEntries.some((entry) => resolvedToken.allows[entry]);
  if (!isAllowed) {
    return jsonResponse(403, {
      error: "forbidden_by_scope_policy",
      reason: `missing allowlist entry for '${access.canonicalCommand}' (expected one of: ${access.allowEntries.join(", ")})`,
    });
  }

  return null;
}

function extractBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const [scheme, token] = value.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

async function parseOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function extractOptionalStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim();
}

function extractSubcommand(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const maybeSubcommand = (body as { subcommand?: unknown }).subcommand;
  if (typeof maybeSubcommand !== "string") {
    return null;
  }

  return maybeSubcommand.trim().length > 0 ? maybeSubcommand : null;
}

function extractSubcommands(body: unknown): string[] | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const maybe = (body as { subcommands?: unknown }).subcommands;
  if (!Array.isArray(maybe)) {
    return null;
  }

  const filtered = maybe.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  return filtered.length > 0 ? filtered : null;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function stringifyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
