import type { CommandRunner } from "./command-runner";
import { hasDisallowedMetacharacters, parseSubcommandToArgv } from "./argv";

export interface TokenManager {
  getToken(): Promise<string>;
  rotateToken(): Promise<string>;
}

export interface AppDependencies {
  adminToken: string;
  commandRunner: CommandRunner;
  tokenManager: TokenManager;
}

export interface App {
  fetch(request: Request): Promise<Response>;
}

export function createApp(deps: AppDependencies): App {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/auth/rotate") {
        return await handleRotate(request, deps);
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

  const token = await deps.tokenManager.rotateToken();
  return jsonResponse(200, { token });
}

async function handleApi(request: Request, deps: AppDependencies): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const subcommand = extractSubcommand(body);
  if (!subcommand) {
    return jsonResponse(400, { error: "subcommand must be a non-empty string" });
  }

  if (hasDisallowedMetacharacters(subcommand)) {
    return jsonResponse(400, { error: "subcommand contains disallowed metacharacters" });
  }

  let argv: string[];
  try {
    argv = parseSubcommandToArgv(subcommand);
  } catch (error) {
    return jsonResponse(400, { error: stringifyErrorMessage(error, "invalid_subcommand") });
  }

  if (isAuthSubcommand(argv)) {
    const providedAdminToken = request.headers.get("x-admin-token");
    if (!providedAdminToken || providedAdminToken !== deps.adminToken) {
      return jsonResponse(401, { error: "unauthorized" });
    }
  } else {
    const bearer = extractBearerToken(request.headers.get("authorization"));
    if (!bearer) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    const currentToken = await deps.tokenManager.getToken();
    if (bearer !== currentToken) {
      return jsonResponse(401, { error: "unauthorized" });
    }
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

function isAuthSubcommand(argv: string[]): boolean {
  return argv[0] === "auth";
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
