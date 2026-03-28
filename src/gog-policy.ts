import { spawnSync } from "node:child_process";
import { normalizeScopeLevel, type ScopeLevel } from "./scopes";

export type AccessRequirement =
  | {
      kind: "admin";
      canonicalCommand: string;
      topLevel: string;
    }
  | {
      kind: "scoped";
      canonicalCommand: string;
      topLevel: string;
      requiredScope: ScopeLevel;
    }
  | {
      kind: "unknown";
      reason: string;
    };

export interface GogPolicy {
  resolveAccess(argv: string[]): AccessRequirement;
  parseScopeSpec(spec: string): { scopeMap: Record<string, ScopeLevel>; normalizedSpec: string };
  allScopedTopLevels(): string[];
}

interface SchemaNode {
  name: string;
  aliases: string[];
  help: string;
  subcommands: SchemaNode[];
}

interface TreeNode {
  name: string;
  aliases: Set<string>;
  help: string;
  children: TreeNode[];
}

const READ_KEYWORDS = [
  "list",
  "ls",
  "get",
  "info",
  "show",
  "search",
  "find",
  "status",
  "history",
  "path",
  "keys",
  "cat",
  "structure",
  "url",
  "colors",
  "time",
  "freebusy",
  "conflicts",
  "export",
  "download",
  "read",
  "whoami",
  "me",
  "version",
  "schema",
];

const SAFE_WRITE_KEYWORDS = [
  "create",
  "add",
  "new",
  "update",
  "edit",
  "set",
  "insert",
  "append",
  "modify",
  "rename",
  "move",
  "mkdir",
  "format",
  "freeze",
  "resize",
  "mark-read",
  "unread",
  "react",
  "reply",
  "respond",
  "watch",
  "done",
  "undo",
  "write",
  "replace-slide",
];

const FULL_WRITE_KEYWORDS = [
  "send",
  "delete",
  "remove",
  "rm",
  "del",
  "trash",
  "unshare",
  "share",
  "suspend",
  "accept",
  "return",
  "turn-in",
  "reclaim",
  "join",
  "leave",
  "archive",
  "unarchive",
  "run",
  "start",
  "stop",
  "clear",
];

// Conservative overrides for ambiguous commands where keyword heuristics can be misleading.
const FORCE_SCOPE: Record<string, ScopeLevel> = {
  "calendar respond": "FULL_WRITE",
  "config set": "FULL_WRITE",
  "config unset": "FULL_WRITE",
  "docs export": "READ",
  "download": "READ",
  "drive download": "READ",
  "gmail drafts send": "FULL_WRITE",
  "gmail send": "FULL_WRITE",
  "keep attachment": "READ",
  "send": "FULL_WRITE",
  "sheets export": "READ",
  "slides export": "READ",
  "tasks done": "SAFE_WRITE",
  "tasks undo": "SAFE_WRITE",
};

export function loadGogPolicy(gogBin: string): GogPolicy {
  const schemaRoot = loadSchemaRoot(gogBin);
  const root = buildTree({
    ...schemaRoot,
    name: "",
    aliases: [],
  });
  const leafHelpMap = new Map<string, string>();
  const leafPaths = collectLeafPaths(root, [], leafHelpMap);
  const aliasRedirects = collectAliasRedirects(leafHelpMap);
  const normalizedLeafPaths = leafPaths.map((path) => applyRedirects(path, aliasRedirects));

  const requiredScopeByLeaf = new Map<string, ScopeLevel>();
  for (const normalizedPath of normalizedLeafPaths) {
    const key = normalizedPath.join(" ");
    const help = leafHelpMap.get(normalizedPath.join(" ")) ?? leafHelpMap.get(key) ?? "";
    requiredScopeByLeaf.set(key, classifyRequiredScope(normalizedPath, help));
  }

  const scopedTopLevels = Array.from(
    new Set(
      normalizedLeafPaths
        .map((parts) => parts[0])
        .filter((part) => part.length > 0 && part !== "auth"),
    ),
  ).sort();

  const topLevelAliasToCanonical = buildTopLevelAliasMap(root, aliasRedirects);

  return {
    resolveAccess(argv: string[]): AccessRequirement {
      if (argv.length === 0) {
        return { kind: "unknown", reason: "empty command" };
      }

      const resolved = resolveCanonicalPath(root, argv);
      if (!resolved) {
        return { kind: "unknown", reason: "unrecognized command path" };
      }

      const redirected = applyRedirects(resolved.commandPath, aliasRedirects);
      const canonicalCommand = redirected.join(" ");
      const topLevel = redirected[0];

      if (!topLevel) {
        return { kind: "unknown", reason: "missing top-level command" };
      }

      if (topLevel === "auth") {
        return {
          kind: "admin",
          canonicalCommand,
          topLevel,
        };
      }

      const leafScope = requiredScopeByLeaf.get(canonicalCommand);
      if (!leafScope) {
        // Command groups (e.g. `calendar --help`) default to READ if top-level is known.
        if (scopedTopLevels.includes(topLevel)) {
          return {
            kind: "scoped",
            canonicalCommand,
            topLevel,
            requiredScope: "READ",
          };
        }
        return { kind: "unknown", reason: "command not in policy catalog" };
      }

      return {
        kind: "scoped",
        canonicalCommand,
        topLevel,
        requiredScope: leafScope,
      };
    },

    parseScopeSpec(spec: string): { scopeMap: Record<string, ScopeLevel>; normalizedSpec: string } {
      const entries = spec
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (entries.length === 0) {
        throw new Error("scopeSpec must contain at least one subcommand:SCOPE entry");
      }

      const scopeMap: Record<string, ScopeLevel> = {};
      for (const entry of entries) {
        const [rawKey, rawScope, extra] = entry.split(":");
        if (!rawKey || !rawScope || extra !== undefined) {
          throw new Error(`Invalid scope entry: '${entry}'`);
        }

        const canonicalKey = normalizeTopLevelKey(rawKey.trim(), topLevelAliasToCanonical);
        if (!canonicalKey) {
          throw new Error(`Unknown top-level subcommand in scope entry: '${rawKey.trim()}'`);
        }
        if (canonicalKey === "auth") {
          throw new Error("auth scope entry is not allowed; auth* commands are admin-only");
        }
        if (!scopedTopLevels.includes(canonicalKey)) {
          throw new Error(`Subcommand '${canonicalKey}' is not scope-managed`);
        }
        if (scopeMap[canonicalKey]) {
          throw new Error(`Duplicate scope entry for subcommand '${canonicalKey}'`);
        }

        const normalizedScope = normalizeScopeLevel(rawScope);
        if (!normalizedScope) {
          throw new Error(`Invalid scope level '${rawScope}' in entry '${entry}'`);
        }
        scopeMap[canonicalKey] = normalizedScope;
      }

      const normalizedSpec = Object.entries(scopeMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, scope]) => `${key}:${scope}`)
        .join(",");

      return { scopeMap, normalizedSpec };
    },

    allScopedTopLevels(): string[] {
      return [...scopedTopLevels];
    },
  };
}

function classifyRequiredScope(pathParts: string[], helpText: string): ScopeLevel {
  const key = pathParts.join(" ");
  if (FORCE_SCOPE[key]) {
    return FORCE_SCOPE[key];
  }

  const text = `${key} ${helpText}`.toLowerCase();
  if (matchesAnyKeyword(text, FULL_WRITE_KEYWORDS)) {
    return "FULL_WRITE";
  }
  if (matchesAnyKeyword(text, SAFE_WRITE_KEYWORDS)) {
    return "SAFE_WRITE";
  }
  if (matchesAnyKeyword(text, READ_KEYWORDS)) {
    return "READ";
  }

  // Conservative default for ambiguous commands: treat as FULL_WRITE.
  return "FULL_WRITE";
}

function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function loadSchemaRoot(gogBin: string): SchemaNode {
  const result = spawnSync(gogBin, ["schema", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to execute '${gogBin} schema --json': ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`'${gogBin} schema --json' failed: ${result.stderr || "unknown error"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse gog schema JSON: ${stringifyError(error)}`);
  }

  const command = (parsed as { command?: unknown }).command;
  if (!command || typeof command !== "object") {
    throw new Error("Invalid gog schema: missing command root");
  }

  return normalizeSchemaNode(command as Record<string, unknown>);
}

function normalizeSchemaNode(node: Record<string, unknown>): SchemaNode {
  const name = typeof node.name === "string" ? node.name : "";
  const aliases = Array.isArray(node.aliases)
    ? node.aliases.filter((value): value is string => typeof value === "string")
    : [];
  const help = typeof node.help === "string" ? node.help : "";
  const subcommands = Array.isArray(node.subcommands)
    ? node.subcommands
        .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
        .map((value) => normalizeSchemaNode(value))
    : [];

  return {
    name,
    aliases,
    help,
    subcommands,
  };
}

function buildTree(root: SchemaNode): TreeNode {
  return {
    name: root.name,
    aliases: new Set(root.aliases.map((alias) => alias.toLowerCase())),
    help: root.help,
    children: root.subcommands.map((sub) => buildTree(sub)),
  };
}

function collectLeafPaths(
  node: TreeNode,
  path: string[],
  leafHelpMap: Map<string, string>,
): string[][] {
  const currentPath = node.name ? [...path, node.name] : [...path];
  if (node.children.length === 0) {
    const key = currentPath.join(" ");
    leafHelpMap.set(key, firstLine(node.help));
    return [currentPath];
  }

  const leaves: string[][] = [];
  for (const child of node.children) {
    leaves.push(...collectLeafPaths(child, currentPath, leafHelpMap));
  }
  return leaves;
}

function collectAliasRedirects(leafHelpMap: Map<string, string>): Map<string, string[]> {
  const redirects = new Map<string, string[]>();
  const pattern = /alias for '([^']+)'/i;
  for (const [path, help] of leafHelpMap.entries()) {
    const match = help.match(pattern);
    if (!match) {
      continue;
    }
    const target = match[1]
      .trim()
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (target.length > 0) {
      redirects.set(path, target);
    }
  }
  return redirects;
}

function buildTopLevelAliasMap(root: TreeNode, redirects: Map<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const child of root.children) {
    const canonical = applyRedirects([child.name], redirects)[0] ?? child.name;
    map.set(child.name.toLowerCase(), canonical);
    for (const alias of child.aliases) {
      map.set(alias.toLowerCase(), canonical);
    }
  }
  return map;
}

function resolveCanonicalPath(root: TreeNode, argv: string[]): { commandPath: string[] } | null {
  const commandPath: string[] = [];
  let node = root;

  for (const token of argv) {
    if (token.startsWith("-")) {
      break;
    }
    const child = findMatchingChild(node, token);
    if (!child) {
      break;
    }
    commandPath.push(child.name);
    node = child;
  }

  if (commandPath.length === 0) {
    return null;
  }

  return { commandPath };
}

function findMatchingChild(node: TreeNode, token: string): TreeNode | null {
  const lowered = token.toLowerCase();
  for (const child of node.children) {
    if (child.name.toLowerCase() === lowered) {
      return child;
    }
    if (child.aliases.has(lowered) || Array.from(child.aliases).some((alias) => alias.toLowerCase() === lowered)) {
      return child;
    }
  }
  return null;
}

function normalizeTopLevelKey(key: string, aliasMap: Map<string, string>): string | null {
  const lowered = key.toLowerCase();
  return aliasMap.get(lowered) ?? null;
}

function applyRedirects(path: string[], redirects: Map<string, string[]>): string[] {
  let current = [...path];
  for (let i = 0; i < 5; i += 1) {
    const key = current.join(" ");
    const redirected = redirects.get(key);
    if (!redirected) {
      return current;
    }
    current = [...redirected];
  }
  return current;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
