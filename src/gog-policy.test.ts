import { describe, expect, it } from "bun:test";
import { loadGogPolicy } from "./gog-policy";

describe("gog policy", () => {
  const policy = loadGogPolicy("gog");

  it("treats auth* commands as admin-only", () => {
    const access = policy.resolveAccess(["auth", "status"]);
    expect(access.kind).toBe("admin");
  });

  it("classifies gmail draft creation as SAFE_WRITE", () => {
    const access = policy.resolveAccess(["gmail", "drafts", "create"]);
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.topLevel).toBe("gmail");
      expect(access.requiredScope).toBe("SAFE_WRITE");
    }
  });

  it("classifies gmail draft sending as FULL_WRITE", () => {
    const access = policy.resolveAccess(["gmail", "drafts", "send", "abc"]);
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.topLevel).toBe("gmail");
      expect(access.requiredScope).toBe("FULL_WRITE");
    }
  });

  it("normalizes alias scope keys in scopeSpec parsing", () => {
    const parsed = policy.parseScopeSpec("mail:read,calendar:FULL_WRITE");
    expect(parsed.normalizedSpec).toBe("calendar:FULL_WRITE,gmail:READ");
    expect(parsed.scopeMap.gmail).toBe("READ");
    expect(parsed.scopeMap.calendar).toBe("FULL_WRITE");
  });

  it("rejects auth key in scopeSpec", () => {
    expect(() => policy.parseScopeSpec("auth:FULL_WRITE")).toThrow("admin-only");
  });
});

