import { describe, expect, it } from "bun:test";
import { loadGogPolicy } from "./gog-policy";

describe("gog policy", () => {
  const policy = loadGogPolicy("gog");

  it("treats auth* commands as admin-only", () => {
    const access = policy.resolveAccess(["auth", "status"]);
    expect(access.kind).toBe("admin");
  });

  it("maps gmail draft commands to allowlist entries", () => {
    const access = policy.resolveAccess(["gmail", "drafts", "create"]);
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.topLevel).toBe("gmail");
      expect(access.allowEntries).toEqual(["gmail", "gmail:drafts"]);
    }
  });

  it("maps gmail search commands to allowlist entries", () => {
    const access = policy.resolveAccess(["gmail", "search", "--today"]);
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.topLevel).toBe("gmail");
      expect(access.allowEntries).toEqual(["gmail", "gmail:search"]);
    }
  });

  it("keeps canonical redirect for top-level aliases", () => {
    const access = policy.resolveAccess(["gmail", "drafts", "send", "abc"]);
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.canonicalCommand).toBe("gmail drafts send");
    }
  });

  it("normalizes alias allowlist keys in scopeSpec parsing", () => {
    const parsed = policy.parseScopeSpec("mail:find,calendar");
    expect(parsed.normalizedSpec).toBe("calendar,gmail:search");
    expect(parsed.allowMap.calendar).toBeTrue();
    expect(parsed.allowMap["gmail:search"]).toBeTrue();
  });

  it("rejects auth key and legacy scope levels in scopeSpec", () => {
    expect(() => policy.parseScopeSpec("auth")).toThrow("admin-only");
  });
});
