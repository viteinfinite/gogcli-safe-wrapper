export interface AppConfig {
  port: number;
  secretService: string;
  apiTokenAccount: string;
  adminTokenAccount: string;
  linuxFallbackPath: string;
  gogBin: string;
  platform: NodeJS.Platform;
}

const DEFAULT_PORT = 3000;
const DEFAULT_SECRET_SERVICE = "gogcli-security-wrapper";
const DEFAULT_API_TOKEN_ACCOUNT = "api-token";
const DEFAULT_ADMIN_TOKEN_ACCOUNT = "admin-token";
const DEFAULT_LINUX_FALLBACK_PATH = "~/.config/gogcli-security-wrapper/secrets.json";

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  return parsed;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  return {
    port: parsePort(env.PORT),
    secretService: env.GWS_SECRET_SERVICE ?? env.GWS_KEYCHAIN_SERVICE ?? DEFAULT_SECRET_SERVICE,
    apiTokenAccount: env.GWS_KEYCHAIN_ACCOUNT ?? DEFAULT_API_TOKEN_ACCOUNT,
    adminTokenAccount: env.GWS_ADMIN_ACCOUNT ?? DEFAULT_ADMIN_TOKEN_ACCOUNT,
    linuxFallbackPath: env.GWS_SECRET_FILE ?? DEFAULT_LINUX_FALLBACK_PATH,
    gogBin: env.GOG_BIN ?? "gog",
    platform,
  };
}
