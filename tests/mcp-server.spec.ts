import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useBuiltCli } from "./helpers/built-cli.js";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";
import { startMcpServer, type McpServerProcess } from "./helpers/mcp-client.js";
import { runMain, tempDir } from "./helpers/node-cart.js";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "node-cart");
const SPAWNED = { timeout: 30_000 };

const cli = useBuiltCli("mcp");

interface Setup {
  /** A fresh copy of the cart, its own repository, outside the repo. */
  cart: string;
  home: string;
  configHome: string;
}

function setup(files: Readonly<Record<string, string>> = {}): Setup {
  const cart = fs.realpathSync(tempDir("dtd-mcp-cart-"));
  fs.cpSync(FIXTURE, cart, { recursive: true });
  markRepositoryRoot(cart);
  for (const [relative, contents] of Object.entries(files)) fs.writeFileSync(path.join(cart, relative), contents);
  return { cart, home: tempDir("dtd-mcp-home-"), configHome: tempDir("dtd-mcp-config-") };
}

function envOf(where: Setup): NodeJS.ProcessEnv {
  const env = { ...hermeticEnv(), DOT_TEST_DIGEST_HOME: where.home, XDG_CONFIG_HOME: where.configHome };
  delete env["TYPESAFE_API_KEY"];
  return env;
}

const servers: McpServerProcess[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(where: Setup, args: readonly string[] = []): Promise<McpServerProcess> {
  const server = await startMcpServer(cli.entry(), args, { cwd: where.cart, env: envOf(where) });
  servers.push(server);
  return server;
}

/** Spawns the built CLI with `node <nodeFlags> index.js <args>`, stdin closed at once. */
function spawnBuilt(nodeFlags: readonly string[], args: readonly string[], where: Setup): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeFlags, cli.entry(), ...args], { cwd: where.cart, env: envOf(where), stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.resume();
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("mcp serves four tools over stdio, and nothing else on stdout", () => {
  it("The tool list", SPAWNED, async () => {
    const server = await serve(setup());
    const { tools } = await server.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["run_tests", "show_log", "replay", "list_runs"]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("Stdout carries only protocol messages", SPAWNED, async () => {
    const server = await serve(setup(), ["--allow", "node --test"]);
    await server.client.callTool({ name: "run_tests", arguments: { command: ["node", "--test", "cart.test.js"] } });
    await server.client.callTool({ name: "show_log", arguments: { run: "last" } });
    const lines = server.stdout().split("\n").filter((line) => line.length > 0);
    // The initialize response and the two call results, at least.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, line).toBe("2.0");
  });

  it("A normal run does not load the SDK", SPAWNED, async () => {
    const where = setup();
    const hooks = path.join(where.home, "hooks.mjs");
    const loaded = path.join(where.home, "loaded.txt");
    fs.writeFileSync(
      hooks,
      [
        'import { appendFileSync } from "node:fs";',
        "export async function load(url, context, next) {",
        `  appendFileSync(${JSON.stringify(loaded)}, url + "\\n");`,
        "  return next(url, context);",
        "}",
      ].join("\n"),
    );
    const register = path.join(where.home, "register.mjs");
    fs.writeFileSync(
      register,
      `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
    );
    const loads = (): string[] => fs.readFileSync(loaded, "utf8").split("\n").filter((line) => line.length > 0);

    const run = await spawnBuilt(["--import", register], ["--no-jev", "--", "node", "--test", "passing.test.js"], where);
    expect(run.code, run.stderr).toBe(0);
    const normal = loads();
    expect(normal).toContain(pathToFileURL(cli.entry()).href);
    expect(normal.filter((url) => url.includes("@modelcontextprotocol"))).toEqual([]);

    // The same hook sees the SDK when the subcommand that needs it runs (stdin ends at once, so it exits).
    fs.rmSync(loaded);
    const mcp = await spawnBuilt(["--import", register], ["mcp"], where);
    expect(mcp.code, mcp.stderr).toBe(0);
    expect(loads().some((url) => url.includes("@modelcontextprotocol"))).toBe(true);
  });
});

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(server: McpServerProcess, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await server.client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/** The run logs in the cache: a run creates its log before it starts the child. */
function logsIn(home: string): string[] {
  const dir = path.join(home, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".log")) : [];
}

const RUN_ID = /^run_[0-9a-z]{9,}$/;
const PASSING = ["node", "--test", "passing.test.js"];

describe("run_tests runs only commands the user allowed", () => {
  it("The default allowlist is empty", SPAWNED, async () => {
    const where = setup();
    const server = await serve(where);
    const result = await call(server, "run_tests", { command: PASSING });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("command not allowed: node --test passing.test.js; allowed prefixes: none");
    expect(logsIn(where.home)).toEqual([]);
  });

  it("An allowed command runs and returns the digest", SPAWNED, async () => {
    const server = await serve(setup(), ["--allow", "node --test"]);
    const result = await call(server, "run_tests", { command: PASSING });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/^\[PASS\] 1 passed, 0 failed in \d+ms/);
    expect(result.structuredContent).toEqual({ run_id: expect.stringMatching(RUN_ID), status: "PASS", exit_code: 0 });
  });

  it("A failing test run is a result, not an error", SPAWNED, async () => {
    const server = await serve(setup(), ["--allow", "node --test"]);
    const result = await call(server, "run_tests", { command: ["node", "--test", "cart.test.js"], format: "compact-md" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.["exit_code"]).toBe(1);
    const [header, next] = textOf(result).split("\n");
    expect(header).toMatch(/^\[FAIL\] 4 failed, 2 passed in \d+ms/);
    expect(next).toMatch(/^next: dot-test-digest show run_[0-9a-z]{9,} c_[0-9a-f]{8}$/);
  });

  it("Prefix matching is element-wise", SPAWNED, async () => {
    const where = setup();
    const server = await serve(where, ["--allow", "node --test"]);
    for (const command of [["node", "--testx"], ["node"], ["sh", "-c", "node --test"]]) {
      const result = await call(server, "run_tests", { command });
      expect(result.isError, command.join(" ")).toBe(true);
      expect(textOf(result)).toBe(`command not allowed: ${command.join(" ")}; allowed prefixes: node --test`);
    }
    expect(logsIn(where.home)).toEqual([]);
  });

  it("No shell is involved", SPAWNED, async () => {
    const where = setup();
    const pwned = path.join(where.home, "pwned");
    const server = await serve(where, ["--allow", "node --test"]);
    const result = await call(server, "run_tests", { command: ["node", "--test", `a.test.js; touch ${pwned}`] });
    // It ran, node got the whole string as one file name that does not exist, and nothing else ran.
    expect(result.isError, textOf(result)).toBe(false);
    expect(result.structuredContent?.["exit_code"]).toBe(1);
    const [log] = logsIn(where.home);
    expect(fs.readFileSync(path.join(where.home, "logs", log ?? ""), "utf8")).toContain(`a.test.js; touch ${pwned}`);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it("A working directory outside the project is refused", SPAWNED, async () => {
    const where = setup();
    fs.symlinkSync(fs.realpathSync(os.tmpdir()), path.join(where.cart, "out"));
    const server = await serve(where, ["--allow", "node --test"]);
    for (const cwd of ["..", "out"]) {
      const result = await call(server, "run_tests", { command: PASSING, cwd });
      expect(result.isError, cwd).toBe(true);
      expect(textOf(result)).toMatch(/^cwd outside the project:/);
    }
    expect(logsIn(where.home)).toEqual([]);
    // The guard still lets a directory of the project through.
    const inside = await call(server, "run_tests", { command: PASSING, cwd: "." });
    expect(inside.isError).toBe(false);
  });

  it("The user config extends the allowlist", SPAWNED, async () => {
    const where = setup();
    fs.mkdirSync(path.join(where.configHome, "dot-test-digest"));
    fs.writeFileSync(path.join(where.configHome, "dot-test-digest", "config.json"), '{ "mcp": { "allow": [["pnpm","test"]] } }');
    const server = await serve(where, ["--allow", "node --test"]);
    const pnpm = await call(server, "run_tests", { command: ["pnpm", "test"] });
    expect(textOf(pnpm)).not.toContain("command not allowed");
    const node = await call(server, "run_tests", { command: PASSING });
    expect(node.isError).toBe(false);
    expect(node.structuredContent?.["status"]).toBe("PASS");
  });

  it("A project file cannot extend the allowlist", SPAWNED, async () => {
    const where = setup({ ".dot-test-digest.json": '{ "mcp": { "allow": [["node"]] } }' });
    const server = await serve(where);
    const result = await call(server, "run_tests", { command: PASSING });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("allowed prefixes: none");
    expect(server.stderr()).toContain('ignoring "mcp" in');
  });

  it("The timeout stops the child", SPAWNED, async () => {
    const server = await serve(setup(), ["--allow", "sleep"]);
    const sleepers = (): string[] =>
      spawnSync("ps", ["-eo", "ppid=,args="], { encoding: "utf8" })
        .stdout.split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([ppid, ...args]) => Number(ppid) === server.pid && args.join(" ") === "sleep 30")
        .map((words) => words.join(" "));
    const startedAt = Date.now();
    const pending = call(server, "run_tests", { command: ["sleep", "30"], timeout_seconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The check can see the child while it runs.
    expect(sleepers()).toHaveLength(1);
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^timed out after 1s/);
    expect(sleepers()).toEqual([]);
  });
});

describe("show_log, replay and list_runs give an agent the rest of the story", () => {
  async function cartRun(): Promise<{ where: Setup; server: McpServerProcess; runId: string }> {
    const where = setup();
    const server = await serve(where, ["--allow", "node --test"]);
    const run = await call(server, "run_tests", { command: ["node", "--test", "cart.test.js"] });
    return { where, server, runId: String(run.structuredContent?.["run_id"]) };
  }

  it("show_log returns a range", SPAWNED, async () => {
    const { where, server, runId } = await cartRun();
    const result = await call(server, "show_log", { run: "last", selector: "L15-L17" });
    expect(result.isError).toBe(false);
    const log = fs.readFileSync(path.join(where.home, "logs", `${runId}.log`), "utf8").split("\n");
    expect(textOf(result)).toBe(`${log.slice(14, 17).join("\n")}\n`);
  });

  it("replay returns JSON", SPAWNED, async () => {
    const { server } = await cartRun();
    const result = await call(server, "replay", { run: "last", format: "json", max_clusters: 15 });
    expect(result.isError).toBe(false);
    expect((JSON.parse(textOf(result)) as { summary: { total_clusters: number } }).summary.total_clusters).toBe(4);
  });

  it("list_runs is newest first", SPAWNED, async () => {
    const server = await serve(setup(), ["--allow", "node --test"]);
    const passing = await call(server, "run_tests", { command: PASSING });
    const cart = await call(server, "run_tests", { command: ["node", "--test", "cart.test.js"] });
    const result = await call(server, "list_runs", { limit: 5 });
    expect(result.isError).toBe(false);
    const lines = textOf(result).trimEnd().split("\n");
    const iso = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^${String(cart.structuredContent?.["run_id"])} FAIL ${iso} node --test cart\\.test\\.js$`));
    expect(lines[1]).toMatch(new RegExp(`^${String(passing.structuredContent?.["run_id"])} PASS ${iso} node --test passing\\.test\\.js$`));
  });

  it("A bad reference is an error result", SPAWNED, async () => {
    const server = await serve(setup());
    const result = await call(server, "show_log", { run: "run_zzzzzz" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("no such run: run_zzzzzz");
  });
});

describe("init can print the MCP client entry", () => {
  it("The MCP client snippet", async () => {
    const dir = tempDir("dtd-mcp-snippet-");
    const run = await runMain(["init", "--print-mcp-config"], { cwd: dir, home: tempDir("dtd-mcp-snippet-home-") });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      `${JSON.stringify({ mcpServers: { "dot-test-digest": { command: "dot-test-digest", args: ["mcp"] } } }, null, 2)}\n`,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
