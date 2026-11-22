import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** The SDK's stdio framing over a child the test spawns itself, so it keeps the child's stdout transcript. */
class TappedStdio implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  transcript = "";
  private readonly buffer = new ReadBuffer();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  async start(): Promise<void> {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.transcript += chunk.toString("utf8");
      this.buffer.append(chunk);
      try {
        for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) {
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error as Error);
      }
    });
    this.child.on("close", () => this.onclose?.());
    this.child.on("error", (error) => this.onerror?.(error));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.child.stdin.end();
  }
}

export interface McpServerProcess {
  client: Client;
  pid: number;
  /** Everything the server wrote on stdout so far. */
  stdout(): string;
  stderr(): string;
  /** Closes the client (the server's stdin ends) and waits for the server to exit; kills it after 5 s. */
  close(): Promise<number | null>;
}

export async function startMcpServer(
  entry: string,
  args: readonly string[],
  where: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<McpServerProcess> {
  const child = spawn(process.execPath, [entry, "mcp", ...args], { cwd: where.cwd, env: where.env, stdio: "pipe" });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const transport = new TappedStdio(child);
  const client = new Client({ name: "dot-test-digest-tests", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${(error as Error).message}; server stderr: ${stderr}`);
  }
  return {
    client,
    pid: child.pid ?? -1,
    stdout: () => transport.transcript,
    stderr: () => stderr,
    async close() {
      await client.close();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}
