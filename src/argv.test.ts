import { describe, expect, it } from "bun:test";
import { hasDisallowedMetacharacters, parseSubcommandToArgv } from "./argv";

describe("hasDisallowedMetacharacters", () => {
  it("detects metacharacters and command substitution", () => {
    expect(hasDisallowedMetacharacters("calendar calendars;whoami")).toBeTrue();
    expect(hasDisallowedMetacharacters("calendar calendars | cat")).toBeTrue();
    expect(hasDisallowedMetacharacters("calendar calendars && whoami")).toBeTrue();
    expect(hasDisallowedMetacharacters("calendar calendars `whoami`")).toBeTrue();
    expect(hasDisallowedMetacharacters("calendar calendars $(whoami)")).toBeTrue();
    expect(hasDisallowedMetacharacters("calendar calendars --plain")).toBeFalse();
  });
});

describe("parseSubcommandToArgv", () => {
  it("parses quoted and escaped arguments", () => {
    const argv = parseSubcommandToArgv(
      "calendar calendars -a \"viteinfinite@gmail.com\" --query hello\\ world",
    );
    expect(argv).toEqual([
      "calendar",
      "calendars",
      "-a",
      "viteinfinite@gmail.com",
      "--query",
      "hello world",
    ]);
  });

  it("strips leading gog command", () => {
    const argv = parseSubcommandToArgv("gog calendar calendars --plain");
    expect(argv).toEqual(["calendar", "calendars", "--plain"]);
  });

  it("fails on unclosed quotes", () => {
    expect(() => parseSubcommandToArgv("calendar calendars \"oops")).toThrow(
      "invalid escaping or unclosed quotes",
    );
  });
});
