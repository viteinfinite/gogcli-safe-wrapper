import { createApp } from "./app";
import { GogCommandRunner } from "./command-runner";
import { loadConfig, type AppConfig } from "./config";
import { createSecretStore } from "./secret-store";
import { loadGogPolicy } from "./gog-policy";
import { ScopedTokenManager } from "./scoped-token-manager";

export async function startServer(config: AppConfig = loadConfig()) {
  const secretStore = createSecretStore(config.platform, {
    service: config.secretService,
    linuxFallbackPath: config.linuxFallbackPath,
  });

  const policy = loadGogPolicy(config.gogBin);
  const tokenManager = await ScopedTokenManager.initialize(
    {
      getRegistryPayload: async () => await secretStore.getSecret(config.apiTokenAccount),
      setRegistryPayload: async (payload: string) =>
        await secretStore.setSecret(config.apiTokenAccount, payload),
    },
    policy,
    await secretStore.getSecret(config.apiTokenAccount),
  );
  const adminToken = await secretStore.getSecret(config.adminTokenAccount);
  if (!adminToken) {
    throw new Error(
      `Missing admin token in secret store for service='${config.secretService}' account='${config.adminTokenAccount}'`,
    );
  }

  const commandRunner = new GogCommandRunner(config.gogBin);
  const app = createApp({
    adminToken,
    tokenManager,
    commandRunner,
    policy,
  });

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  console.log(`gws-security-wrapper listening on http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
