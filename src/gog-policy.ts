import { spawnSync } from "node:child_process";

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
      allowEntries: string[];
    }
  | {
      kind: "unknown";
      reason: string;
    };

export interface GogPolicy {
  resolveAccess(argv: string[]): AccessRequirement;
  parseScopeSpec(spec: string): { allowMap: Record<string, true>; normalizedSpec: string };
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
  const normalizedLeafPaths = leafPaths
    .map((path) => applyRedirects(path, aliasRedirects))
    .filter((path) => path.length > 0);

  const scopedTopLevels = Array.from(
    new Set(normalizedLeafPaths.map((path) => path[0]).filter((topLevel) => topLevel !== "auth")),
  ).sort();
  const scopedTopLevelSet = new Set(scopedTopLevels);

  const groupCatalogByTopLevel = buildGroupCatalog(normalizedLeafPaths);
  const topLevelAliasToCanonical = buildTopLevelAliasMap(root, aliasRedirects);
  const groupAliasByTopLevel = buildGroupAliasMap(root, aliasRedirects);

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

      if (!scopedTopLevelSet.has(topLevel)) {
        return { kind: "unknown", reason: "top-level command is not allowlist-managed" };
      }

      if (redirected.length < 2) {
        return {
          kind: "scoped",
          canonicalCommand,
          topLevel,
          allowEntries: [topLevel],
        };
      }

      const group = redirected[1];
      const groups = groupCatalogByTopLevel.get(topLevel);
      if (!groups || !groups.has(group)) {
        return { kind: "unknown", reason: "command group not in policy catalog" };
      }

      return {
        kind: "scoped",
        canonicalCommand,
        topLevel,
        allowEntries: [topLevel, `${topLevel}:${group}`],
      };
    },

    parseScopeSpec(spec: string): { allowMap: Record<string, true>; normalizedSpec: string } {
      const entries = spec
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (entries.length === 0) {
        throw new Error("scopeSpec must contain at least one allowlist entry");
      }

      const allowMap: Record<string, true> = {};
      for (const entry of entries) {
        const parts = entry.split(":");
        if (parts.length > 2) {
          throw new Error(`Invalid allowlist entry: '${entry}'`);
        }

        const rawTopLevel = parts[0]?.trim();
        if (!rawTopLevel) {
          throw new Error(`Invalid allowlist entry: '${entry}'`);
        }

        const canonicalTopLevel = normalizeTopLevelKey(rawTopLevel, topLevelAliasToCanonical);
        if (!canonicalTopLevel) {
          throw new Error(`Unknown top-level command in allowlist entry: '${rawTopLevel}'`);
        }
        if (canonicalTopLevel === "auth") {
          throw new Error("auth allowlist entry is not allowed; auth* commands are admin-only");
        }
        if (!scopedTopLevelSet.has(canonicalTopLevel)) {
          throw new Error(`Command '${canonicalTopLevel}' is not allowlist-managed`);
        }

        let normalizedKey = canonicalTopLevel;
        if (parts.length === 2) {
          const rawGroup = parts[1]?.trim();
          if (!rawGroup) {
            throw new Error(`Invalid allowlist entry: '${entry}'`);
          }

          const canonicalGroup = normalizeGroupKey(canonicalTopLevel, rawGroup, groupAliasByTopLevel);
          if (!canonicalGroup) {
            throw new Error(
              `Unknown command group '${rawGroup}' for top-level command '${canonicalTopLevel}'`,
            );
          }

          const groupCatalog = groupCatalogByTopLevel.get(canonicalTopLevel);
          if (!groupCatalog || !groupCatalog.has(canonicalGroup)) {
            throw new Error(`Command group '${canonicalTopLevel}:${canonicalGroup}' is not allowlist-managed`);
          }

          normalizedKey = `${canonicalTopLevel}:${canonicalGroup}`;
        }

        if (allowMap[normalizedKey]) {
          throw new Error(`Duplicate allowlist entry '${normalizedKey}'`);
        }
        allowMap[normalizedKey] = true;
      }

      const normalizedSpec = Object.keys(allowMap)
        .sort((a, b) => a.localeCompare(b))
        .join(",");

      return { allowMap, normalizedSpec };
    },

    allScopedTopLevels(): string[] {
      return [...scopedTopLevels];
    },
  };
}

function buildGroupCatalog(normalizedLeafPaths: string[][]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const path of normalizedLeafPaths) {
    const topLevel = path[0];
    if (!topLevel || topLevel === "auth") {
      continue;
    }

    if (!map.has(topLevel)) {
      map.set(topLevel, new Set());
    }

    const group = path[1];
    if (group) {
      map.get(topLevel)?.add(group);
    }
  }

  return map;
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

function buildGroupAliasMap(root: TreeNode, redirects: Map<string, string[]>): Map<string, Map<string, string>> {
  const byTopLevel = new Map<string, Map<string, string>>();

  for (const topLevelNode of root.children) {
    const canonicalTopLevel = applyRedirects([topLevelNode.name], redirects)[0] ?? topLevelNode.name;
    if (!byTopLevel.has(canonicalTopLevel)) {
      byTopLevel.set(canonicalTopLevel, new Map<string, string>());
    }
    const groupMap = byTopLevel.get(canonicalTopLevel);
    if (!groupMap) {
      continue;
    }

    for (const groupNode of topLevelNode.children) {
      const canonicalPath = applyRedirects([canonicalTopLevel, groupNode.name], redirects);
      const canonicalGroup = canonicalPath[1] ?? groupNode.name;
      groupMap.set(groupNode.name.toLowerCase(), canonicalGroup);
      for (const alias of groupNode.aliases) {
        groupMap.set(alias.toLowerCase(), canonicalGroup);
      }
    }
  }

  return byTopLevel;
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
    if (child.name.toLowerCase() === lowered || child.aliases.has(lowered)) {
      return child;
    }
  }
  return null;
}

function normalizeTopLevelKey(key: string, aliasMap: Map<string, string>): string | null {
  const lowered = key.toLowerCase();
  return aliasMap.get(lowered) ?? null;
}

function normalizeGroupKey(
  topLevel: string,
  group: string,
  groupAliasByTopLevel: Map<string, Map<string, string>>,
): string | null {
  const groupMap = groupAliasByTopLevel.get(topLevel);
  if (!groupMap) {
    return null;
  }
  return groupMap.get(group.toLowerCase()) ?? null;
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
