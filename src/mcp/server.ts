import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OutputFormatSchema, TddPhaseSchema } from "../types/schema.js";
import { VERSION } from "../version.js";
import { McpTools, type ToolOutcome, type ToolsOptions } from "./tools.js";

const runRef = z.string().describe('"last" (the newest run of this directory), a run id, or a unique prefix of 6+ characters');
const maxClusters = z.number().int().min(1).max(15).optional();
const contextLines = z.number().int().min(0).max(5).optional();

function result(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    isError: outcome.isError,
    ...(outcome.structured ? { structuredContent: { ...outcome.structured } } : {}),
  };
}

/** Serves the four tools on stdin and stdout until stdin ends. Every stdout byte is the SDK's; diagnostics go to `warn`. */
export async function serveMcp(options: ToolsOptions): Promise<void> {
  const tools = new McpTools(options);
  const server = new McpServer({ name: "dot-test-digest", version: VERSION });
  const inFlight = new Set<Promise<unknown>>();
  /** Calls still running when stdin ends are answered before the server closes (a client may pipe its requests in). */
  const tracked = (outcome: ToolOutcome | Promise<ToolOutcome>): Promise<CallToolResult> => {
    const call = Promise.resolve(outcome).then(result);
    inFlight.add(call);
    void call.finally(() => inFlight.delete(call)).catch(() => {});
    return call;
  };

  server.registerTool(
    "run_tests",
    {
      description:
        "Run a test, compiler or build command (an argv array, never a shell string) and return its bounded digest. Only commands whose leading words match an allowed prefix run.",
      inputSchema: {
        command: z.array(z.string()).min(1).describe('argv, e.g. ["pnpm", "test"]'),
        cwd: z.string().optional().describe("working directory, inside the server's directory"),
        format: z.enum(["compact-md", "json"]).optional(),
        max_clusters: maxClusters,
        context_lines: contextLines,
        tdd_phase: TddPhaseSchema.optional(),
        timeout_seconds: z.number().int().min(1).max(3600).optional().describe("default 300"),
      },
      outputSchema: { run_id: z.string(), status: z.string(), exit_code: z.number().int() },
    },
    (args) => tracked(tools.runTests(args)),
  );
  server.registerTool(
    "show_log",
    {
      description: "Print a run's raw log, or a range (L<a>-L<b>, <a>-<b>, L<a>) or a cluster's lines of it.",
      inputSchema: { run: runRef, selector: z.string().optional() },
    },
    (args) => tracked(tools.showLog(args)),
  );
  server.registerTool(
    "replay",
    {
      description: "Print the digest of a recorded run again, without running anything.",
      inputSchema: { run: runRef, format: OutputFormatSchema.optional(), max_clusters: maxClusters, context_lines: contextLines },
    },
    (args) => tracked(tools.replay(args)),
  );
  server.registerTool(
    "list_runs",
    {
      description: "The newest runs of this directory, one per line: <run_id> <status> <created_at> <command>.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("default 10") },
    },
    (args) => tracked(tools.listRuns(args)),
  );

  const stdinEnded = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await server.connect(new StdioServerTransport());
  await stdinEnded;
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  // The SDK writes a result a few promise turns after its handler settles; a macrotask runs after all of them.
  await new Promise((resolve) => setImmediate(resolve));
  await server.close();
}
