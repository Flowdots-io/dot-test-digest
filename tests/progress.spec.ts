import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runNodeCart, tempDir } from "./helpers/node-cart.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("--progress", () => {
  it("On a terminal the heartbeat overwrites itself", async () => {
    const dir = tempDir("dtd-progress-");
    markRepositoryRoot(dir);
    const home = tempDir("dtd-progress-home-");
    const writes: { stream: "stdout" | "stderr"; text: string }[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push({ stream: "stdout", text: String(chunk) });
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push({ stream: "stderr", text: String(chunk) });
      return true;
    });
    const originalCwd = process.cwd();
    const originalHome = process.env["DOT_TEST_DIGEST_HOME"];
    process.chdir(dir);
    process.env["DOT_TEST_DIGEST_HOME"] = home;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    let clock = 0;
    try {
      const running = main(["--no-jev", "--progress", "--", "sh", "-c", "sleep 1"], {
        stdoutIsTTY: false,
        stderrIsTTY: true,
        now: () => clock,
        env: { ...hermeticEnv(), DOT_TEST_DIGEST_HOME: home, XDG_CONFIG_HOME: path.join(home, "config-home") },
      });
      for (let second = 1; second <= 25; second += 1) {
        clock = second * 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(await running).toBe(0);
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env["DOT_TEST_DIGEST_HOME"];
      else process.env["DOT_TEST_DIGEST_HOME"] = originalHome;
    }

    const stderr = writes.filter((write) => write.stream === "stderr").map((write) => write.text);
    expect(stderr).toEqual([
      "\rdot-test-digest: running... 0 lines, 10.0s",
      "\rdot-test-digest: running... 0 lines, 20.0s",
      "\r\u001b[K",
    ]);
    const clearedAt = writes.findIndex((write) => write.text === "\r\u001b[K");
    const digestAt = writes.findIndex((write) => write.stream === "stdout" && write.text.startsWith("[PASS]"));
    expect(digestAt).toBeGreaterThan(clearedAt);
  });

  it("A fast child prints no heartbeat", async () => {
    const run = await runNodeCart(["--no-jev", "--progress"], ["passing.test.js"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
  });
});
