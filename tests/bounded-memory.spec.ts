import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatEnvelope } from "../src/formatters/envelope.js";
import { digestRun, type DigestSettings } from "../src/pipeline.js";
import { defaultLineSources, LogLines, type LineSourceFactory } from "../src/runner/line-source.js";
import type { OutputFormat } from "../src/types/schema.js";
import { runInCart, runNodeCart, tempDir } from "./helpers/node-cart.js";

const LOGS = path.join(process.cwd(), "tests", "fixtures", "logs");

function settings(format: OutputFormat): DigestSettings {
  return { tddPhase: "none", format, maxClusters: 5, contextLines: 2, noJev: true, retryFlakes: false, allowNoTests: false };
}

async function digestOf(lines: LogLines, logPath: string, format: OutputFormat) {
  return digestRun({
    output: { lines, exitCode: 1, signal: null, durationMs: 0 },
    command: [],
    repoRoot: path.dirname(logPath),
    confineWindows: true,
    logPath,
    runId: "run_mzzzzzzz00000000",
    settings: settings(format),
    previousState: null,
    color: false,
    timed: false,
  });
}

/** A factory that keeps every source it creates, for the test to inspect after the run. */
function spyingFactory(): { factory: LineSourceFactory; created: LogLines[] } {
  const created: LogLines[] = [];
  return {
    created,
    factory: (span) => {
      const source = defaultLineSources(span);
      created.push(source);
      return source;
    },
  };
}

describe("bounded memory: line sources", () => {
  it("Small outputs are not read from disk", async () => {
    const spy = spyingFactory();
    const run = await runNodeCart(["--no-jev"], ["cart.test.js"], { deps: { lineSources: spy.factory } });
    expect(run.code).toBe(1);
    expect(spy.created).toHaveLength(1);
    const [source] = spy.created;
    expect(source?.mode).toBe("memory");
    expect(source?.stats.chunkReads).toBe(0);
  });

  it.each(["node-tap-cart.log", "vitest-cart.log"])(
    "A file-backed source gives the same digest as the in-memory one (%s)",
    async (fixture) => {
      const logPath = path.join(tempDir("dtd-bounded-"), fixture);
      fs.copyFileSync(path.join(LOGS, fixture), logPath);
      for (const format of ["compact-md", "json"] as const) {
        const inMemory = LogLines.read(logPath);
        const fileBacked = LogLines.read(logPath, 0);
        expect(inMemory.mode).toBe("memory");
        expect(fileBacked.mode).toBe("file");
        const expected = (await digestOf(inMemory, logPath, format)).digest;
        expect(expected).toContain("FAIL");
        expect((await digestOf(fileBacked, logPath, format)).digest).toBe(expected);
        expect(fileBacked.stats.chunkReads).toBeGreaterThan(0);
      }
    },
  );

  it("The raw text is built only for tiny outputs", async () => {
    // 100 rows of 30 bytes: 3,000 bytes no grammar recognizes.
    const script = 'for (let i = 0; i < 100; i++) console.log("row " + String(i).padStart(4, "0") + " of a plain log."); process.exit(1)';
    const spy = spyingFactory();
    const run = await runInCart(["--no-jev"], [process.execPath, "-e", script], { deps: { lineSources: spy.factory } });
    expect(run.code).toBe(1);
    const [source] = spy.created;
    expect(source?.bytes).toBe(3000);
    expect(source?.stats.fullReads).toBe(0);
    expect(run.stdout).toMatch(/^\[FAIL\] exit 1 in \d+ms/);

    // The digest is the one the ladder gave when the raw text was always built.
    const logs = path.join(run.home, "logs");
    const logPath = path.join(logs, fs.readdirSync(logs).find((name) => name.endsWith(".log")) ?? "");
    const lines = LogLines.read(logPath);
    const outcome = await digestOf(lines, logPath, "compact-md");
    expect(lines.stats.fullReads).toBe(0);
    const before = formatEnvelope(outcome.envelope, "compact-md", {
      omitted: [],
      rawText: fs.readFileSync(logPath, "utf8"),
      color: false,
      timed: false,
    });
    expect(outcome.digest).toBe(before);
  });
});
