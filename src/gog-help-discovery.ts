function parseCommandsSection(helpText: string): string[] {
  const lines = helpText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) {
    return [];
  }

  const commands = new Set<string>();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^ {2}([a-z0-9][a-z0-9-]*)\b/i);
    if (!match) {
      continue;
    }
    commands.add(match[1].toLowerCase());
  }

  return [...commands].sort((a, b) => a.localeCompare(b));
}

export function extractTopLevelCommandsFromRootHelp(helpText: string): string[] {
  return parseCommandsSection(helpText);
}

export function extractThirdLevelGroupsFromTopLevelHelp(helpText: string): string[] {
  return parseCommandsSection(helpText);
}
