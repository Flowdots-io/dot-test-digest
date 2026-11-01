import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

const TSC_12 = path.resolve(import.meta.dirname, "fixtures", "logs", "tsc-12.log");

let originalCwd: string;
let home: string;
let project: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  originalCwd = process.cwd();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-project-"));
  process.env["DOT_TEST_DIGEST_HOME"] = home;
  process.chdir(project);
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  delete process.env["DOT_TEST_DIGEST_HOME"];
});

function replayLog(logPath: string): string[] {
  return [
    process.execPath,
    "-e",
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(logPath)},'utf8')); process.exit(2)`,
  ];
}

describe("source-order ranking through the CLI", () => {
  it("--max-clusters keeps the first clusters in source order", async () => {
    const code = await main(["--no-jev", "--format=json", "--max-clusters=5", "--", ...replayLog(TSC_12)]);
    expect(code).toBe(2);
    const envelope = JSON.parse(stdout) as { clusters: { raw_log_lines: string }[] };
    expect(envelope.clusters.map((c) => c.raw_log_lines)).toEqual([
      "L1-L1",
      "L2-L2",
      "L3-L3",
      "L4-L4",
      "L5-L5",
    ]);
    expect(stderr).toBe("");
  });
});
