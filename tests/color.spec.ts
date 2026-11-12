import { describe, expect, it } from "vitest";
import type { MainDeps } from "../src/index.js";
import { runMain, runNodeCart, tempDir, type CartRun } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const ESC = "\u001b";
const SGR = /\u001b\[[0-9;]*m/g;

function header(stdout: string): string {
  return stdout.split("\n")[0] ?? "";
}

/** A terminal (or not) with only the given variables, so the caller's NO_COLOR and TERM never leak in. */
function terminal(isTTY: boolean, vars: NodeJS.ProcessEnv = {}): MainDeps {
  return { stdoutIsTTY: isTTY, env: { XDG_CONFIG_HOME: tempDir("dtd-xdg-"), ...vars } };
}

/** The digest with this run's directory, home, durations and log name masked. */
function masked(run: CartRun): string {
  return run.stdout
    .split(run.dir)
    .join("<dir>")
    .split(run.home)
    .join("<home>")
    .replace(/\d+ms/g, "<t>ms")
    .replace(/run_[0-9a-z]+/g, "<run>");
}

describe("the colored status word (terminal-color)", () => {
  it("always colors a pass line", async () => {
    const run = await runNodeCart([...NO_JEV, "--color=always"], ["passing.test.js"]);
    expect(header(run.stdout).startsWith(`[${ESC}[32mPASS${ESC}[0m] 1 passed, 0 failed`)).toBe(true);
    expect(run.code).toBe(0);
  });

  it("always colors a failure red", async () => {
    const run = await runNodeCart([...NO_JEV, "--color=always"], ["cart.test.js"]);
    expect(header(run.stdout).startsWith(`[${ESC}[31mFAIL${ESC}[0m] 4 failed, 2 passed`)).toBe(true);
    expect(run.code).toBe(1);
  });

  it("Stripping the color gives the plain output", async () => {
    for (const file of ["passing.test.js", "cart.test.js"]) {
      const colored = await runNodeCart([...NO_JEV, "--color=always"], [file]);
      const plain = await runNodeCart([...NO_JEV, "--color=never"], [file]);
      expect(colored.stdout).toContain(ESC);
      expect(plain.stdout).not.toContain(ESC);
      expect(masked(colored).replace(SGR, "")).toBe(masked(plain));
    }
  });

  it("Auto is plain when stdout is not a terminal", async () => {
    const run = await runNodeCart(NO_JEV, ["passing.test.js"], { deps: terminal(false) });
    expect(run.stdout).not.toContain(ESC);
    expect(run.code).toBe(0);
  });

  it("Auto colors on a terminal unless NO_COLOR is set", async () => {
    const plainTerminal = await runNodeCart(NO_JEV, ["passing.test.js"], { deps: terminal(true) });
    expect(plainTerminal.stdout).toContain(`${ESC}[32m`);
    const noColor = await runNodeCart(NO_JEV, ["passing.test.js"], { deps: terminal(true, { NO_COLOR: "1" }) });
    expect(noColor.stdout).not.toContain(ESC);
    const forced = await runNodeCart([...NO_JEV, "--color=always"], ["passing.test.js"], {
      deps: terminal(true, { NO_COLOR: "1" }),
    });
    expect(forced.stdout).toContain(`${ESC}[32m`);
  });

  it("JSON is never colored", async () => {
    const run = await runNodeCart([...NO_JEV, "--color=always", "--format=json"], ["passing.test.js"]);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(ESC);
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  it("A bad color value is a usage error", async () => {
    const run = await runMain(["--color=blue", "--", "true"], { cwd: tempDir("dtd-color-"), home: tempDir("dtd-color-home-") });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe("--color must be auto, always or never\n");
  });
});
