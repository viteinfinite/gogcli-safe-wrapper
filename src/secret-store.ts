import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { deletePassword, getPassword, setPassword } from "@napi-rs/keyring/keytar";

export interface SecretStore {
  getSecret(account: string): Promise<string | null>;
  setSecret(account: string, value: string): Promise<void>;
}

interface SecretStoreFactoryOptions {
  service: string;
  linuxFallbackPath: string;
}

interface NativeSecretBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

interface LinuxSecretStoreDeps {
  nativeBackend?: NativeSecretBackend;
}

const defaultNativeBackend: NativeSecretBackend = {
  getPassword,
  setPassword,
  deletePassword,
};

export class MacOSKeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly nativeBackend: NativeSecretBackend = defaultNativeBackend,
  ) {}

  async getSecret(account: string): Promise<string | null> {
    try {
      return await this.nativeBackend.getPassword(this.service, account);
    } catch (error) {
      throw new Error(`Failed to read secret from keychain: ${stringifyError(error)}`);
    }
  }

  async setSecret(account: string, value: string): Promise<void> {
    try {
      await this.nativeBackend.setPassword(this.service, account, value);
    } catch (error) {
      // Some keychains reject upsert semantics; retry with explicit delete + set.
      try {
        await this.nativeBackend.deletePassword(this.service, account);
        await this.nativeBackend.setPassword(this.service, account, value);
      } catch (retryError) {
        throw new Error(`Failed to write secret to keychain: ${stringifyError(retryError)}`);
      }
    }
  }
}

export class LinuxSecretStore implements SecretStore {
  private readonly fallbackPath: string;
  private readonly nativeBackend: NativeSecretBackend;

  constructor(
    private readonly service: string,
    fallbackPath: string,
    deps: LinuxSecretStoreDeps = {},
  ) {
    this.fallbackPath = expandHomePath(fallbackPath);
    this.nativeBackend = deps.nativeBackend ?? defaultNativeBackend;
  }

  async getSecret(account: string): Promise<string | null> {
    try {
      return await this.nativeBackend.getPassword(this.service, account);
    } catch {
      const secrets = await readFallbackSecrets(this.fallbackPath);
      return secrets[this.service]?.[account] ?? null;
    }
  }

  async setSecret(account: string, value: string): Promise<void> {
    try {
      await this.nativeBackend.setPassword(this.service, account, value);
      return;
    } catch {
      const secrets = await readFallbackSecrets(this.fallbackPath);
      const nextServiceSecrets = {
        ...(secrets[this.service] ?? {}),
        [account]: value,
      };
      const nextSecrets = {
        ...secrets,
        [this.service]: nextServiceSecrets,
      };

      await fs.mkdir(dirname(this.fallbackPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.fallbackPath, JSON.stringify(nextSecrets, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.chmod(this.fallbackPath, 0o600);
    }
  }
}

export function createSecretStore(
  platform: NodeJS.Platform,
  options: SecretStoreFactoryOptions,
): SecretStore {
  if (platform === "darwin") {
    return new MacOSKeychainSecretStore(options.service);
  }
  if (platform === "linux") {
    return new LinuxSecretStore(options.service, options.linuxFallbackPath);
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return process.env.HOME ?? pathValue;
  }
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      return pathValue;
    }
    return `${home}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

async function readFallbackSecrets(pathValue: string): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = await fs.readFile(pathValue, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("fallback secret file is not a valid JSON object");
    }
    return parsed as Record<string, Record<string, string>>;
  } catch (error) {
    if (isFileMissingError(error)) {
      return {};
    }
    throw new Error(`Failed to read fallback secret file: ${stringifyError(error)}`);
  }
}

function isFileMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT";
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
