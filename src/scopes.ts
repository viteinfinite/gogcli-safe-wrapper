export type ScopeLevel = "READ" | "SAFE_WRITE" | "FULL_WRITE";

const SCOPE_PRIORITY: Record<ScopeLevel, number> = {
  READ: 1,
  SAFE_WRITE: 2,
  FULL_WRITE: 3,
};

export function normalizeScopeLevel(value: string): ScopeLevel | null {
  const upper = value.trim().toUpperCase();
  if (upper === "READ" || upper === "SAFE_WRITE" || upper === "FULL_WRITE") {
    return upper;
  }
  return null;
}

export function satisfiesScope(granted: ScopeLevel, required: ScopeLevel): boolean {
  return SCOPE_PRIORITY[granted] >= SCOPE_PRIORITY[required];
}

export function sortScopeEntries(
  scopeMap: Record<string, ScopeLevel>,
): Array<{ key: string; scope: ScopeLevel }> {
  return Object.entries(scopeMap)
    .map(([key, scope]) => ({ key, scope }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

