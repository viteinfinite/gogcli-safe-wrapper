import { describe, expect, it } from "bun:test";
import { extractThirdLevelGroupsFromTopLevelHelp, extractTopLevelCommandsFromRootHelp } from "./gog-help-discovery";

describe("gog help discovery parsers", () => {
  it("extracts top-level commands from root help", () => {
    const rootHelp = `
Usage: gog <command> [flags]

Commands:
  send [flags]
    Send an email
  gmail (mail,email) <command> [flags]
    Gmail
  schema [<command> ...] [flags]
    Machine-readable schema
`;

    expect(extractTopLevelCommandsFromRootHelp(rootHelp)).toEqual(["gmail", "schema", "send"]);
  });

  it("extracts command groups from top-level help and ignores category headers", () => {
    const gmailHelp = `
Usage: gog gmail <command> [flags]

Commands:

Read
  search (find,query,ls,list) <query> ... [flags]
    Search threads
  messages (message,msg,msgs) <command>
    Message operations

Organize
  drafts (draft) <command>
    Draft operations
`;

    expect(extractThirdLevelGroupsFromTopLevelHelp(gmailHelp)).toEqual(["drafts", "messages", "search"]);
  });
});
