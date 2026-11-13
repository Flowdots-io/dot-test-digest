import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useBuiltCli } from "./helpers/built-cli.js";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";
import { startMcpServer, type McpServerProcess } from "./helpers/mcp-client.js";
import { tempDir } from "./helpers/node-cart.js";

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
