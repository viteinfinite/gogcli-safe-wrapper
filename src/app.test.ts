import { describe, expect, it } from "bun:test";
import { createApp, type TokenManager } from "./app";
import type { CommandRunResult, CommandRunner } from "./command-runner";

class FakeTokenManager implements TokenManager {
  constructor(private token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }

  async rotateToken(): Promise<string> {
    this.token = `rotated-${this.token}`;
    return this.token;
  }
}

class FakeRunner implements CommandRunner {
  public calls: string[][] = [];
  constructor(private nextResult: CommandRunResult) {}

  async run(argv: string[]): Promise<CommandRunResult> {
    this.calls.push(argv);
    return this.nextResult;
  }
}

function buildApp(opts?: {
  token?: string;
  adminToken?: string;
  runResult?: CommandRunResult;
}) {
  const tokenManager = new FakeTokenManager(opts?.token ?? "api-token");
  const runner = new FakeRunner(opts?.runResult ?? { output: "ok\n", exitCode: 0 });
  const app = createApp({
    adminToken: opts?.adminToken ?? "admin-token",
    tokenManager,
    commandRunner: runner,
  });
  return { app, tokenManager, runner };
}

describe("POST /api auth for non-auth subcommands", () => {
  it("returns 401 when bearer auth is missing", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ subcommand: "calendar calendars --plain" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when bearer token is invalid", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ subcommand: "calendar calendars --plain" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("POST /api auth* subcommands", () => {
  it("requires admin token for auth subcommands", async () => {
    const { app, runner } = buildApp();

    const missingAdminResponse = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ subcommand: "auth status --plain" }),
      }),
    );
    expect(missingAdminResponse.status).toBe(401);

    const withAdminResponse = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
        },
        body: JSON.stringify({ subcommand: "auth status --plain" }),
      }),
    );
    expect(withAdminResponse.status).toBe(200);
    expect(runner.calls).toEqual([["auth", "status", "--plain"]]);
  });
});

describe("POST /auth/rotate", () => {
  it("returns 401 when admin token is missing", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/auth/rotate", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rotates the API token and invalidates previous bearer for non-auth calls", async () => {
    const { app, runner } = buildApp();

    const rotateResponse = await app.fetch(
      new Request("http://localhost/auth/rotate", {
        method: "POST",
        headers: {
          "X-Admin-Token": "admin-token",
        },
      }),
    );
    expect(rotateResponse.status).toBe(200);
    const rotateBody = (await rotateResponse.json()) as { token: string };
    expect(rotateBody.token.startsWith("rotated-")).toBeTrue();

    const oldTokenResponse = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer api-token",
        },
        body: JSON.stringify({ subcommand: "calendar calendars --plain" }),
      }),
    );
    expect(oldTokenResponse.status).toBe(401);

    const newTokenResponse = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotateBody.token}`,
        },
        body: JSON.stringify({ subcommand: "calendar calendars --plain" }),
      }),
    );
    expect(newTokenResponse.status).toBe(200);
    expect(runner.calls.length).toBe(1);
  });
});

describe("POST /api execution behavior", () => {
  it("parses argv safely and calls runner with parsed args", async () => {
    const { app, runner } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer api-token",
        },
        body: JSON.stringify({
          subcommand: "calendar calendars -a \"viteinfinite@gmail.com\" --plain",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runner.calls).toEqual([
      ["calendar", "calendars", "-a", "viteinfinite@gmail.com", "--plain"],
    ]);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("ok\n");
  });

  it("returns 200 and raw output even when command exits non-zero", async () => {
    const { app } = buildApp({
      runResult: {
        output: "Error: unknown command\n",
        exitCode: 1,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer api-token",
        },
        body: JSON.stringify({ subcommand: "calendar nope" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Error: unknown command\n");
  });
});

describe("POST /api input validation", () => {
  it("rejects disallowed metacharacters and does not execute runner", async () => {
    const { app, runner } = buildApp();
    const badInputs = [
      "calendar calendars; whoami",
      "calendar calendars | cat",
      "calendar calendars && whoami",
      "calendar calendars `whoami`",
      "calendar calendars $(whoami)",
    ];

    for (const subcommand of badInputs) {
      const response = await app.fetch(
        new Request("http://localhost/api", {
          method: "POST",
          headers: {
            Authorization: "Bearer api-token",
          },
          body: JSON.stringify({ subcommand }),
        }),
      );

      expect(response.status).toBe(400);
    }

    expect(runner.calls.length).toBe(0);
  });

  it("rejects invalid json body", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://localhost/api", {
        method: "POST",
        headers: {
          Authorization: "Bearer api-token",
          "Content-Type": "application/json",
        },
        body: "{not-json}",
      }),
    );

    expect(response.status).toBe(400);
  });
});
