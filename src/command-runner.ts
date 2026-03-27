import { spawn } from "node:child_process";

export interface CommandRunResult {
  output: string;
  exitCode: number;
}

export interface CommandRunner {
  run(argv: string[]): Promise<CommandRunResult>;
}

export class GogCommandRunner implements CommandRunner {
  constructor(private readonly gogBin: string) {}

  async run(argv: string[]): Promise<CommandRunResult> {
    return await new Promise<CommandRunResult>((resolve, reject) => {
      const child = spawn(this.gogBin, argv, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      child.stdout?.on("data", (chunk: string | Buffer) => {
        output += chunk.toString();
      });

      child.stderr?.on("data", (chunk: string | Buffer) => {
        output += chunk.toString();
      });

      child.once("error", (error) => {
        reject(new Error(`Failed to execute gog: ${error.message}`));
      });

      child.once("close", (code) => {
        resolve({
          output,
          exitCode: code ?? 1,
        });
      });
    });
  }
}
