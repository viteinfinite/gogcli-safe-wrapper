const DISALLOWED_META_CHARS = /[;|&`]/;

export function hasDisallowedMetacharacters(subcommand: string): boolean {
  return DISALLOWED_META_CHARS.test(subcommand) || subcommand.includes("$(");
}

export function parseSubcommandToArgv(subcommand: string): string[] {
  const trimmed = subcommand.trim();
  if (!trimmed) {
    throw new Error("subcommand must be a non-empty string");
  }

  const argv: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const char of trimmed) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (!inSingleQuote && char === "\\") {
      escapeNext = true;
      continue;
    }

    if (!inDoubleQuote && char === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && char === "\"") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escapeNext || inSingleQuote || inDoubleQuote) {
    throw new Error("subcommand contains invalid escaping or unclosed quotes");
  }

  if (current.length > 0) {
    argv.push(current);
  }

  if (argv.length === 0) {
    throw new Error("subcommand must contain at least one argument");
  }

  if (argv[0] === "gog") {
    argv.shift();
  }

  if (argv.length === 0) {
    throw new Error("subcommand must include arguments after gog");
  }

  return argv;
}
