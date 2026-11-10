import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS, classifyMessage, runGear0, selectAdapter, type AdapterResult } from "../src/adapters/index.js";
import { jsTestAdapter } from "../src/adapters/js-test.js";
import type { CapturedLine } from "../src/runner/capture.js";
import { nodeRunsWrapperSource, tempDir } from "./helpers/node-cart.js";

function lines(text: string): CapturedLine[] {
  return text.split("\n").map((line, index) => ({
    stream: "stdout" as const,
    text: line,
    line: index + 1,
  }));
}

const VITEST_FAILURE = ` FAIL  tests/auth.spec.ts > login > rejects expired token
AssertionError: expected 200 to be 401
Expected: 401
Received: 200
 ❯ parseToken (src/auth/jwt.ts:28:19)
 ❯ node_modules/vitest/dist/chunk.js:1:1

 Test Files  1 failed | 31 passed (32)
      Tests  1 failed | 239 passed (240)`;

const VITEST_PASS = ` ✓ tests/auth.spec.ts (12 tests) 640ms
 Test Files  32 passed (32)
      Tests  240 passed (240)`;

const VITEST_COMPACT = ` RUN  v2.1.9 /work/repo

 ❯ file-01.spec.ts (1 test | 1 failed) 5ms
   × ACCEPTANCE cascade file 01 > case 0 5ms
     → token.split is not a function

⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  file-01.spec.ts > ACCEPTANCE cascade file 01 > case 0
 FAIL  file-02.spec.ts > ACCEPTANCE cascade file 02 > case 0
TypeError: token.split is not a function
 ❯ parseToken src/helper.ts:5:20
 ❯ file-01.spec.ts:10:11
 ❯ node_modules/vitest/dist/chunk.js:1:1

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 Test Files  2 failed (2)
      Tests  2 failed (2)`;

const VITEST_COMPACT_INLINE = ` ❯ tests/auth.spec.ts (1 test | 1 failed) 640ms
   × login > rejects expired token 10ms
     → expected 200 to be 401
 ❯ parseToken src/auth/jwt.ts:28:19

 Test Files  1 failed (32)
      Tests  1 failed | 239 passed (240)`;

const TSC = `src/auth/jwt.ts(28,19): error TS2339: Property 'split' does not exist on type 'Token'.
src/auth/session.ts(12,5): error TS2339: Property 'split' does not exist on type 'Token'.
src/import.ts(3,10): error TS2307: Cannot find module './helprs' or its corresponding type declarations.`;

const PYTEST = `============================= test session starts ==============================
collected 3 items

=================================== FAILURES ===================================
___________________________________ test_total ___________________________________

    def test_total():
>       assert cart.total() == 100
E       AssertionError: assert 99 == 100

tests/test_cart.py:12: in test_total
    assert cart.total() == 100
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total - AssertionError: assert 99 == 100
========================= 1 failed, 2 passed in 0.12s =========================`;

const CARGO = `   Compiling app v0.1.0
error[E0308]: mismatched types
 --> src/main.rs:4:9
  |
4 |     let x: u8 = "s";
  |         ^^^^^^ expected \`u8\`, found \`&str\`

thread 'tests::parse' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`;

const GO = `--- FAIL: TestTotal (0.00s)
    cart_test.go:12: got 99, want 100
FAIL
exit status 1
FAIL	example.com/cart	0.002s`;

describe("registry", () => {
  it("exposes four adapters", () => {
    expect(ADAPTERS.map((a) => a.name)).toEqual([
      "js-test",
      "tsc-eslint",
      "python",
      "rust-go",
    ]);
  });

  it("selects the vitest grammar for a vitest stream", () => {
    expect(selectAdapter(lines(VITEST_FAILURE).map((l) => l.text))?.name).toBe("js-test");
  });

  it("selects the go grammar, not js-test, for a go stream", () => {
    expect(selectAdapter(lines(GO).map((l) => l.text))?.name).toBe("rust-go");
  });

  it("returns null when nothing matches", () => {
    expect(runGear0(lines("hello\nworld"))).toBeNull();
  });
});

describe("js-test adapter", () => {
  it("extracts the failing test, its diff and its frames", () => {
    const result = runGear0(lines(VITEST_FAILURE));
    expect(result?.counts).toEqual({ passed: 239, failed: 1, skipped: 0 });
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("login > rejects expired token");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.message).toContain("expected 200 to be 401");
    expect(failure?.diff).toEqual({ expected: "401", received: "200" });
    expect(failure?.frames).toEqual([
      "parseToken (src/auth/jwt.ts:28:19)",
      "node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("reads counts from a clean passing run and produces no failures", () => {
    const result = runGear0(lines(VITEST_PASS));
    expect(result?.counts).toEqual({ passed: 240, failed: 0, skipped: 0 });
    expect(result?.failures).toEqual([]);
  });

  it("parses the non-TTY compact reporter into one failure per test", () => {
    const result = runGear0(lines(VITEST_COMPACT));
    expect(result?.counts).toEqual({ passed: 0, failed: 2, skipped: 0 });
    const failures = result?.failures ?? [];
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.testName)).toEqual([
      "ACCEPTANCE cascade file 01 > case 0",
      "ACCEPTANCE cascade file 02 > case 0",
    ]);
    expect(failures.map((f) => f.testFile)).toEqual(["file-01.spec.ts", "file-02.spec.ts"]);
    for (const failure of failures) {
      expect(failure.message).toBe("TypeError: token.split is not a function");
      expect(failure.frames).toContain("parseToken src/helper.ts:5:20");
      expect(failure.errorKind).toBe("RUNTIME_EXCEPTION");
    }
    // The banner must never become a test or a frame.
    expect(failures.some((f) => f.testName?.includes("tests |"))).toBe(false);
    expect(failures.some((f) => f.frames.some((frame) => frame.includes("tests |")))).toBe(false);
  });

  it("keeps inline stacks from a TTY reporter and strips the row duration", () => {
    const [failure] = runGear0(lines(VITEST_COMPACT_INLINE))?.failures ?? [];
    expect(failure?.testName).toBe("login > rejects expired token");
    expect(failure?.testFile).toBe("tests/auth.spec.ts");
    expect(failure?.message).toBe("expected 200 to be 401");
    expect(failure?.diff).toEqual({ expected: "401", received: "200" });
    expect(failure?.frames).toEqual(["parseToken src/auth/jwt.ts:28:19"]);
  });

  it("classifies an unresolved import as SYNTAX_IMPORT_ERROR", () => {
    const stream = ` FAIL  tests/discount.spec.ts > applies discount
Error: Failed to resolve import "./helprs" from "tests/discount.spec.ts". Does the file exist?
 ❯ tests/discount.spec.ts:3:1

      Tests  1 failed (1)`;
    const [failure] = runGear0(lines(stream))?.failures ?? [];
    expect(failure?.errorKind).toBe("SYNTAX_IMPORT_ERROR");
  });
});

describe("tsc adapter", () => {
  it("parses one diagnostic per error line", () => {
    const result = runGear0(lines(TSC));
    expect(result?.failures).toHaveLength(3);
    expect(result?.counts.failed).toBe(3);
    expect(result?.failures.map((f) => f.errorKind)).toEqual([
      "TYPE_COMPILE_ERROR",
      "TYPE_COMPILE_ERROR",
      "SYNTAX_IMPORT_ERROR",
    ]);
    expect(result?.failures[0]?.frames).toEqual(["src/auth/jwt.ts:28:19"]);
    expect(result?.failures[0]?.message).toBe("TS2339: Property 'split' does not exist on type 'Token'.");
  });
});

describe("python adapter", () => {
  it("parses the traceback block instead of duplicating it from the summary", () => {
    const result = runGear0(lines(PYTEST));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(result?.failures).toHaveLength(1);
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("test_total");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.frames).toEqual(["tests/test_cart.py:12"]);
  });
});

describe("rust-go adapter", () => {
  it("parses a rustc span and a panic", () => {
    const result = runGear0(lines(CARGO));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    const kinds = result?.failures.map((f) => f.errorKind) ?? [];
    expect(kinds).toContain("TYPE_COMPILE_ERROR");
    expect(kinds).toContain("RUNTIME_EXCEPTION");
    expect(result?.failures.find((f) => f.errorKind === "RUNTIME_EXCEPTION")?.frames).toEqual([
      "src/lib.rs:10:5",
    ]);
  });

  it("parses a go test failure location", () => {
    const result = runGear0(lines(GO));
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("TestTotal");
    expect(failure?.message).toBe("got 99, want 100");
    expect(failure?.frames).toEqual(["cart_test.go:12"]);
  });
});

describe("classifyMessage", () => {
  it.each([
    ["AssertionError: expected 1 to be 2", "ASSERTION_FAILURE"],
    ["Cannot find module './x'", "SYNTAX_IMPORT_ERROR"],
    ["Timeout of 5000ms exceeded", "TIMEOUT_OR_CONN_REFUSED"],
    ["ECONNREFUSED 127.0.0.1:5432", "TIMEOUT_OR_CONN_REFUSED"],
    ["TypeError: token.split is not a function", "RUNTIME_EXCEPTION"],
    ["SyntaxError: The requested module './cart.mjs' does not provide an export named 'missingThing'", "RUNTIME_EXCEPTION"],
  ] as const)("classifies %s", (message, kind) => {
    expect(classifyMessage(message)).toBe(kind);
  });
});

describe("tap grammar", () => {
  it("parses a TAP block from node:test", () => {
    const stream = [
      "not ok 1 - cart totals",
      "  ---",
      "  error: |-",
      "    AssertionError: expected 99 to be 100",
      "  ...",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1",
    ].join("\n");
    const result = runGear0(lines(stream));
    expect(result?.adapter).toBe("js-test");
    expect(result?.counts.failed).toBe(1);
    expect(result?.failures).toHaveLength(1);
    expect(result?.failures[0]?.errorKind).toBe("ASSERTION_FAILURE");
  });
});

describe("node TAP diagnostic blocks", () => {
  it("A recorded TAP log parses to the same records at the adapter seam", () => {
    const root = path.join(process.cwd(), "tests", "fixtures", "node-cart");
    const text = fs
      .readFileSync(path.join(process.cwd(), "tests", "fixtures", "logs", "node-tap-cart.log"), "utf8")
      .replaceAll("__ROOT__", root)
      .replace(/\n$/, "");
    const result = runGear0(lines(text));

    expect(result?.adapter).toBe("js-test");
    expect(result?.counts).toEqual({ passed: 2, failed: 4, skipped: 0 });
    expect(result?.failures).toHaveLength(4);
    expect(result?.failures.map((f) => f.testFile)).toEqual([
      "tests/fixtures/node-cart/cart.test.js",
      "tests/fixtures/node-cart/cart.test.js",
      "tests/fixtures/node-cart/cart.test.js",
      "tests/fixtures/node-cart/cart.test.js",
    ]);
    expect(result?.failures.map((f) => [f.startLine, f.endLine])).toEqual([
      [15, 39],
      [41, 65],
      [67, 91],
      [93, 111],
    ]);
  });

  it("A TAP block without a failureType key keeps the v0.1.2 behavior", () => {
    const stream = [
      "not ok 1 - cart totals",
      "  ---",
      "  error: |-",
      "    AssertionError: expected 99 to be 100",
      "  ...",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1",
    ].join("\n");
    const result = runGear0(lines(stream));

    expect(result?.adapter).toBe("js-test");
    expect(result?.counts.failed).toBe(1);
    expect(result?.failures).toHaveLength(1);
    expect(result?.failures[0]?.errorKind).toBe("ASSERTION_FAILURE");
    expect(result?.failures[0]?.message).toBe("AssertionError: expected 99 to be 100");
  });

  it("A TAP block without a failureType key keeps the v0.1.2 behavior (inside a stream with a Subtest line)", () => {
    const stream = [
      "# Subtest: cart totals",
      "not ok 1 - cart totals",
      "  ---",
      "  error: |-",
      "    AssertionError: expected 99 to be 100",
      "  ...",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1",
    ].join("\n");
    const result = runGear0(lines(stream));

    expect(result?.adapter).toBe("js-test");
    expect(result?.counts.failed).toBe(1);
    expect(result?.failures).toHaveLength(1);
    expect(result?.failures[0]?.errorKind).toBe("ASSERTION_FAILURE");
    expect(result?.failures[0]?.message).toBe("AssertionError: expected 99 to be 100");
    expect(result?.failures[0]?.diff).toEqual({ expected: "100", received: "99" });
  });

  it("A stream mixing node blocks, blocks without a failureType key and a cut-short entry keeps the stream order", () => {
    const nodeBlock = (name: string, line: number): string[] => [
      `# Subtest: ${name}`,
      `not ok 1 - ${name}`,
      "  ---",
      "  duration_ms: 1",
      "  type: 'test'",
      `  location: '/work/x.test.js:${line}:1'`,
      "  failureType: 'testCodeFailure'",
      `  error: 'boom ${name}'`,
      "  code: 'ERR_TEST_FAILURE'",
      "  name: 'Error'",
      "  stack: |-",
      "    at x (/work/x.test.js:1:1)",
      "  ...",
    ];
    const stream = [
      "not ok 1 - cut short",
      "not ok 2 - foreign",
      "  ---",
      "  error: |-",
      "    AssertionError: expected 99 to be 100",
      "  ...",
      ...nodeBlock("same", 3),
      ...nodeBlock("same", 5),
      "not ok 3 - outer",
      "  ---",
      "  FAIL inner thing",
      "  TypeError: nope",
      "  ...",
      ...nodeBlock("last", 9),
    ].join("\n");
    const result = runGear0(lines(stream));

    expect(result?.failures.map((f) => f.testName)).toEqual([
      "cut short",
      "foreign",
      "same @3",
      "same @5",
      "outer",
      "inner thing",
      "last",
    ]);
    expect(result?.failures.map((f) => f.startLine)).toEqual([1, 2, 8, 21, 33, 35, 39]);
  });
});

describe("node spec reporter at the adapter seam", () => {
  it("A recorded spec log parses at the adapter seam", () => {
    const root = path.join(process.cwd(), "tests", "fixtures", "node-cart");
    const log = fs
      .readFileSync(path.join(process.cwd(), "tests", "fixtures", "logs", "node-spec-cart.log"), "utf8")
      .replaceAll("__ROOT__", root);
    const result = runGear0(lines(log.replace(/\n$/, "")));

    expect(result?.adapter).toBe("js-test");
    expect(result?.counts).toEqual({ passed: 2, failed: 4, skipped: 0 });
    expect(result?.failures.map((f) => f.testName)).toEqual([
      "discount 10% leaves 90%",
      "total with 10% off",
      "total with 100% off is free",
      "first of an empty cart is undefined",
    ]);
    expect(result?.failures.map((f) => f.testFile)).toEqual(Array(4).fill("cart.test.js"));
    expect(result?.failures.map((f) => [f.startLine, f.endLine])).toEqual([
      [18, 37],
      [39, 58],
      [60, 79],
      [81, 91],
    ]);
  });

  /** One node run of crashing files: what each printed, then its `✖` row, then the summary and the failing-tests section. */
  function specRun(crashed: ReadonlyArray<{ file: string; above: readonly string[] }>): string[] {
    const counts = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"].map(
      (key) => `ℹ ${key} ${key === "tests" || key === "fail" ? crashed.length : 0}`,
    );
    return [
      ...crashed.flatMap(({ file, above }) => [...above, `✖ ${file} (5.1ms)`]),
      ...counts,
      "",
      "✖ failing tests:",
      ...crashed.flatMap(({ file }) => ["", `test at ${file}:1:1`, `✖ ${file} (5.1ms)`, "  'test failed'"]),
    ];
  }

  function crashBlock(file: string, error: string): string[] {
    return [
      `file:///work/${file}:5`,
      "throw new Error();",
      "      ^",
      "",
      error,
      `    at file:///work/${file}:5:7`,
      "",
      "Node.js v22.23.4",
    ];
  }

  const crashes = (result: AdapterResult): Array<[string, string]> =>
    result.failures.map((f) => [(f.testName ?? "").replace(/ @\d+$/, ""), f.message]);

  it("Two crashing files under the spec reporter each carry the crash block directly above their own row", () => {
    const result = jsTestAdapter.parse(
      lines(
        specRun([
          { file: "crash-b.test.js", above: crashBlock("crash-b.test.js", "TypeError: boom b") },
          { file: "crash-a.test.js", above: crashBlock("crash-a.test.js", "Error [ERR_X]: boom a") },
        ]).join("\n"),
      ),
    );

    expect(crashes(result)).toEqual([
      ["crash-b.test.js", "TypeError: boom b"],
      ["crash-a.test.js", "Error: boom a"],
    ]);
  });

  it("Lines above a file's row that are not its crash block never give its message (other file's output, a block cut off from the row)", () => {
    const result = jsTestAdapter.parse(
      lines(
        specRun([
          { file: "log.test.js", above: ["Error: the loader gave up", "    at somewhere (node:internal/x:1:1)"] },
          { file: "cut.test.js", above: [...crashBlock("cut.test.js", "TypeError: boom"), "✔ a test row in between (1.0ms)"] },
          { file: "nolocation.test.js", above: ["TypeError: boom", "Node.js v22.23.4"] },
          { file: "notrailer.test.js", above: ["file:///work/notrailer.test.js:5", "TypeError: boom"] },
        ]).join("\n"),
      ),
    );

    expect(result.failures.map((f) => f.message)).toEqual(Array(4).fill("test failed"));
  });

  it("A diagnostic row between a file's crash block and its row does not cut the block off, and the previous run's summary is not a block", () => {
    const result = jsTestAdapter.parse(
      lines(
        specRun([
          { file: "ok.test.js", above: ["ℹ tests 1", "ℹ pass 0", "ℹ fail 1"] },
          { file: "crash.test.js", above: [...crashBlock("crash.test.js", "TypeError: boom"), "ℹ a diagnostic row"] },
        ]).join("\n"),
      ),
    );

    expect(crashes(result)).toEqual([
      ["ok.test.js", "test failed"],
      ["crash.test.js", "TypeError: boom"],
    ]);
  });

  it("A crash block gives its first error line; a log line before its location line is outside it", () => {
    const block = crashBlock("a.test.js", "TypeError: boom");
    const above = ["Error: setup log", ...block.slice(0, -1), "RangeError: cause", ...block.slice(-1)];
    const result = jsTestAdapter.parse(lines(specRun([{ file: "a.test.js", above }]).join("\n")));

    expect(result.failures.map((f) => f.message)).toEqual(["TypeError: boom"]);
  });

  /** Two node runs of the same crashing file in one stream: each run prints its own crash block and `✖` row. */
  function twoRunsOfOneFile(blocks: readonly [readonly string[], readonly string[]]): CapturedLine[] {
    const run = (above: readonly string[]): string[] => specRun([{ file: "twice.test.js", above }]);
    return lines([...run(blocks[0]), ...run(blocks[1])].join("\n"));
  }

  it("The same file crashing in two runs keeps each run's own error (direct parse)", () => {
    const result = jsTestAdapter.parse(
      twoRunsOfOneFile([
        crashBlock("twice.test.js", "TypeError: first run"),
        crashBlock("twice.test.js", "RangeError: second run"),
      ]),
    );

    expect(crashes(result)).toEqual([
      ["twice.test.js", "TypeError: first run"],
      ["twice.test.js", "RangeError: second run"],
    ]);
  });

  it("The same file crashing in two runs keeps each run's own error (a real stream)", () => {
    const dir = tempDir("dtd-twice-");
    fs.writeFileSync(
      path.join(dir, "twice.test.js"),
      [
        'import fs from "node:fs";',
        'const marker = new URL("./twice.marker", import.meta.url);',
        'if (fs.existsSync(marker)) { throw new RangeError("second run"); }',
        'fs.writeFileSync(marker, "x");',
        'throw new TypeError("first run");',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "wrapper.js"),
      nodeRunsWrapperSource("spec", ["twice.test.js", "twice.test.js"]),
    );
    const captured = path.join(dir, "stream.txt");
    const fd = fs.openSync(captured, "w");
    spawnSync(process.execPath, ["wrapper.js"], {
      cwd: dir,
      stdio: ["ignore", fd, fd],
    });
    fs.closeSync(fd);

    const result = jsTestAdapter.parse(lines(fs.readFileSync(captured, "utf8").replace(/\n$/, "")));

    expect(crashes(result)).toEqual([
      ["twice.test.js", "TypeError: first run"],
      ["twice.test.js", "RangeError: second run"],
    ]);
  });
});
