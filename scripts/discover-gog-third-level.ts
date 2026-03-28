#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractThirdLevelGroupsFromTopLevelHelp, extractTopLevelCommandsFromRootHelp } from "../src/gog-help-discovery";

const GOG_REPO = "https://github.com/steipete/gogcli.git";

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveLatestTag(repoUrl: string): string {
  const output = run("git", ["ls-remote", "--tags", "--refs", "--sort=-v:refname", repoUrl]);
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) {
    throw new Error("Unable to resolve latest tag for gog repository");
  }
  const ref = line.split("\t")[1];
  if (!ref || !ref.startsWith("refs/tags/")) {
    throw new Error(`Unexpected tag ref output: ${line}`);
  }
  return ref.replace("refs/tags/", "");
}

function buildGogBinary(repoDir: string, outputBinary: string): void {
  try {
    run("go", ["build", "-o", outputBinary, "./cmd/gog"], repoDir);
    return;
  } catch {
    run("go", ["build", "-o", outputBinary, "."], repoDir);
  }
}

function main(): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "gog-discovery-"));
  const cloneDir = join(tempRoot, "gogcli");
  const gogBin = join(tempRoot, "gog");

  try {
    const latestTag = resolveLatestTag(GOG_REPO);
    run("git", ["clone", "--depth", "1", "--branch", latestTag, GOG_REPO, cloneDir]);
    buildGogBinary(cloneDir, gogBin);

    const rootHelp = run(gogBin, ["--help"]);
    const topLevels = extractTopLevelCommandsFromRootHelp(rootHelp);

    const groupsByTopLevel: Record<string, string[]> = {};
    const allowlistKeys = new Set<string>();

    for (const topLevel of topLevels) {
      const topHelp = run(gogBin, [topLevel, "--help"]);
      const groups = extractThirdLevelGroupsFromTopLevelHelp(topHelp);
      groupsByTopLevel[topLevel] = groups;

      for (const group of groups) {
        allowlistKeys.add(`${topLevel}:${group}`);
      }
    }

    const sortedAllowlistKeys = [...allowlistKeys].sort((a, b) => a.localeCompare(b));
    const payload = {
      repository: GOG_REPO,
      tag: latestTag,
      topLevels: topLevels.sort((a, b) => a.localeCompare(b)),
      groupsByTopLevel,
      allowlistKeys: sortedAllowlistKeys,
    };

    console.log(JSON.stringify(payload, null, 2));
    console.log("");
    console.log("Allowlist keys:");
    for (const key of sortedAllowlistKeys) {
      console.log(key);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
