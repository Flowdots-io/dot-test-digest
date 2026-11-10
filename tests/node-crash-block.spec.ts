import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FailureCluster } from "../src/types/schema.js";
import { clustersOf } from "./helpers/digest.js";
import {
  MISSING_EXPORT_MESSAGE,
  MODULE_NOT_FOUND,
  RED,
  REPORTERS,
  SPEC,
  clusterOf,
  eachReporter,
  nodeRunsWrapper,
  reporterFlag,
  runJson,
  source,
  type CartArgs,
  type CartOptions,
  type JsonRun,
  type Reporter,
} from "./helpers/node-cart.js";

const SETUP_LOG = 'data:text/javascript,console.log("Error: config.json not found, using defaults")';
const EXIT_LOAD = source("process.exit(1);");
const LOG_ONLY = source(
  'import test from "node:test";',
  'console.log("TypeError: cfg.get is not a function (handled)");',
  'test("x", () => {});',
);

/**
 * Split in two so a failing run does not print the words "SyntaxError: ..." that the digest of this
 * very test run would classify as an invalid red.
 */
function expectUnexpectedEnd(cluster: FailureCluster | undefined): void {
  const prefix = "SyntaxError: ";
  expect(cluster?.message.startsWith(prefix)).toBe(true);
  expect(cluster?.message.slice(prefix.length)).toBe("Unexpected end of input");
}

/** A file that crashed at startup without naming itself: its own entry says only `test failed`. */
function expectUnattributedCrash({ run, envelope }: JsonRun, file: string): void {
  expect(run.code).toBe(64);
  expect(envelope.status).toBe("INVALID_RED");
  const cluster = clusterOf(envelope, file);
  expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
  expect(cluster?.message).toBe("test failed");
}

describe("node --test, the crash block directly above a file's entry is its error", () => {
  it("A log line above the crash is not mistaken for the file's error", async () => {
    const { run, envelope } = await runJson(["--import", SETUP_LOG, "missing-module.test.js"], { flags: RED });

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)).toHaveLength(1);
    const cluster = clustersOf(envelope)[0];
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
    expect(cluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
  });

  it("A syntax error in a test file is attributed to that file under TAP", async () => {
    const { envelope } = await runJson(["missing-module.test.js", "syntax-error.test.js"]);

    const cluster = clusterOf(envelope, "syntax-error.test.js");
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expectUnexpectedEnd(cluster);
  });

  it("A syntax error block with blank lines is attributed to its file", async () => {
    const { envelope } = await runJson([SPEC, "missing-module.test.js", "syntax-error.test.js"]);

    const cluster = clusterOf(envelope, "syntax-error.test.js");
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expectUnexpectedEnd(cluster);
    expect(clusterOf(envelope, "missing-module.test.js")?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
  });

  eachReporter(
    {
      tap: "A crashed file in a later run of a multi-run stream keeps its error (tap)",
      spec: "A crashed file in a later run of a multi-run stream keeps its error (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await nodeRunsWrapper(reporter, ["cart.test.js", "missing-export.test.js"], {
        flags: RED,
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      const cluster = clusterOf(envelope, "missing-export.test.js");
      expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(cluster?.message).toBe(MISSING_EXPORT_MESSAGE);
    },
  );

  eachReporter(
    {
      tap: "A startup crash is not blamed on another run's output (tap)",
      spec: "A startup crash is not blamed on another run's output (spec)",
    },
    async (reporter) => {
      const result = await nodeRunsWrapper(reporter, ["exitload.test.js", "logc.test.js"], {
        flags: RED,
        files: { "exitload.test.js": EXIT_LOAD, "logc.test.js": LOG_ONLY },
      });

      expectUnattributedCrash(result, "exitload.test.js");
    },
  );

  eachReporter(
    {
      tap: "A crash that does not name the test file keeps its own block (tap)",
      spec: "A crash that does not name the test file keeps its own block (spec)",
    },
    async (reporter) => {
      const result = await runJson([...reporterFlag(reporter), "--import", SETUP_LOG, "deep.test.js"], {
        flags: RED,
        files: {
          "helper.js": source('import "./missing-dep.js";', "export const h = 1;"),
          "deep.test.js": source('import test from "node:test";', 'import "./helper.js";', 'test("x", () => {});'),
        },
      });

      expect(result.run.code).toBe(64);
      expect(result.envelope.status).toBe("INVALID_RED");
      const cluster = clusterOf(result.envelope, "deep.test.js");
      expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
      expect(cluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
      expect(cluster?.message).toContain("missing-dep.js' imported from ");
    },
  );

  eachReporter(
    {
      tap: "A load-time throw of a non-error is an unattributed startup crash (tap)",
      spec: "A load-time throw of a non-error is an unattributed startup crash (spec)",
    },
    async (reporter) => {
      const result = await runJson([...reporterFlag(reporter), "--import", SETUP_LOG, "throw42.test.js"], {
        flags: RED,
        files: { "throw42.test.js": source("throw 42;") },
      });

      expectUnattributedCrash(result, "throw42.test.js");
    },
  );

  const FILE_ORDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["log file first", ["logc.test.js", "exitload.test.js"]],
    ["log file last", ["exitload.test.js", "logc.test.js"]],
  ];

  for (const [reporter, title] of [
    ["tap", "A startup crash is not blamed on another file's log under TAP"],
    ["spec", "A startup crash is not blamed on another file's log, in either file order"],
  ] as const) {
    for (const [order, files] of FILE_ORDERS) {
      it(`${title} (${order})`, async () => {
        const result = await runJson([...reporterFlag(reporter), ...files], {
          flags: RED,
          files: { "exitload.test.js": EXIT_LOAD, "logc.test.js": LOG_ONLY },
        });

        expectUnattributedCrash(result, "exitload.test.js");
      });
    }
  }

  eachReporter(
    {
      tap: "A missing export is VALID_RED with exit 0 (a ReferenceError at load time, whose stack frame names the file, tap)",
      spec: "A missing export is VALID_RED with exit 0 (a ReferenceError at load time, whose stack frame names the file, spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "load-error.test.js"], {
        flags: RED,
        files: { "load-error.test.js": source("import test from 'node:test';", "notDefinedYet();", "test('x', () => {});") },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(clustersOf(envelope).map((c) => [c.error_kind, c.message])).toEqual([
        ["RUNTIME_EXCEPTION", "ReferenceError: notDefinedYet is not defined"],
      ]);
    },
  );

  eachReporter(
    {
      tap: "A runtime error at load is not displaced by an earlier log line (tap)",
      spec: "A runtime error at load is not displaced by an earlier log line (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "refload.test.js"], {
        flags: RED,
        files: {
          "refload.test.js": source(
            "import test from 'node:test';",
            "console.log('SyntaxError: Unexpected token } in JSON (from setup)');",
            "notDefinedYet();",
            "test('x', () => {});",
          ),
        },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(clustersOf(envelope).map((c) => c.message)).toEqual(["ReferenceError: notDefinedYet is not defined"]);
    },
  );
});

const SPACE_DIR = "a b";

/** A load-time TypeError whose location line node prints in a form the crash block must still recognise. */
const LOCATION_FORMS: ReadonlyArray<{ form: string; file: string; contents: string }> = [
  {
    form: "cjs file in a directory with a space",
    file: "typeload.test.cjs",
    contents: source('const test = require("node:test");', "const cfg = {};", 'cfg.get("x");', 'test("x", () => {});'),
  },
  {
    form: "eval code",
    file: "evalload.test.js",
    contents: source('import test from "node:test";', 'eval("null.x");', 'test("x", () => {});'),
  },
  {
    form: "partial stdout line before the location",
    file: "partial.test.js",
    contents: source(
      'import test from "node:test";',
      'process.stdout.write("partial line no newline");',
      "null.x;",
      'test("x", () => {});',
    ),
  },
];

describe("node --test, the location line of a crash block", () => {
  for (const { form, file, contents } of LOCATION_FORMS) {
    for (const reporter of REPORTERS) {
      it(`A load-time error in a path with a space, in eval code, or after a partial line keeps its error (${form}, ${reporter})`, async () => {
        const { run, envelope } = await runJson([...reporterFlag(reporter), file], {
          flags: RED,
          subdir: SPACE_DIR,
          files: { [`${SPACE_DIR}/${file}`]: contents },
        });

        expect(run.code).toBe(0);
        expect(envelope.status).toBe("VALID_RED");
        const cluster = clusterOf(envelope, file);
        expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
        expect(cluster?.message.startsWith("TypeError: ")).toBe(true);
      });
    }
  }
});

/**
 * A server a setup module starts and leaves running. It crashes only once the process that started it (its
 * pid is the argument) is gone, so its crash block always lands after that process's own, whatever the timing.
 */
const CRASHING_SERVER = source(
  "const starter = Number(process.argv[2]);",
  "setInterval(() => {",
  '  if (process.ppid !== starter) throw new TypeError("app.listen is not a function");',
  "}, 5);",
);
const SETUP_DEV = source(
  'import { spawn } from "node:child_process";',
  'const server = new URL("./server.js", import.meta.url).pathname;',
  'spawn(process.execPath, [server, String(process.pid)], { stdio: "inherit" }).unref();',
);
const MULTILINE_THROW = source(
  'import test from "node:test";',
  'throw new TypeError("config invalid at\\n/etc/app/config.json:12");',
);

describe("node --test, several crash blocks above one entry, and a message line that looks like a location", () => {
  eachReporter(
    {
      tap: "A crash of a process started by a setup module does not hide a broken import (tap)",
      spec: "A crash of a process started by a setup module does not hide a broken import (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson(
        [...reporterFlag(reporter), "--import", "./setup-dev.mjs", "missing-module.test.js"],
        { flags: RED, files: { "server.js": CRASHING_SERVER, "setup-dev.mjs": SETUP_DEV } },
      );

      expect(run.code).toBe(64);
      expect(envelope.status).toBe("INVALID_RED");
      const cluster = clusterOf(envelope, "missing-module.test.js");
      expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
      expect(cluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
    },
  );

  eachReporter(
    {
      tap: "A load-time error whose message continues on a line ending in a number keeps its error (tap)",
      spec: "A load-time error whose message continues on a line ending in a number keeps its error (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "multiline.test.js"], {
        flags: RED,
        files: { "multiline.test.js": MULTILINE_THROW },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      const cluster = clusterOf(envelope, "multiline.test.js");
      expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(cluster?.message).toBe("TypeError: config invalid at");
    },
  );
});

const ASYNC_FAIL = source(
  'import test from "node:test";',
  'import { subtotal } from "./cart.js";',
  'test("calls impl", () => { setTimeout(() => { subtotal(undefined).x.y; }, 10); });',
);
const LATE_THROW = source(
  'import test from "node:test";',
  'test("passes", () => {});',
  'setTimeout(() => { throw new TypeError("late boom"); }, 50);',
);

describe("node --test, a file whose tests ran and then failed on a late error", () => {
  eachReporter(
    {
      tap: "A file whose tests ran and then failed on a late error is not a startup crash (tap)",
      spec: "A file whose tests ran and then failed on a late error is not a startup crash (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "asyncfail.test.js"], {
        flags: RED,
        files: { "asyncfail.test.js": ASYNC_FAIL },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      const cluster = clusterOf(envelope, "asyncfail.test.js");
      expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(cluster?.message.startsWith('Error: Test "calls impl" at asyncfail.test.js')).toBe(true);
    },
  );

  eachReporter(
    {
      tap: "A late error in a file-level timer next to failing tests keeps the run a valid red (tap)",
      spec: "A late error in a file-level timer next to failing tests keeps the run a valid red (spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "cart.test.js", "latethrow.test.js"], {
        flags: RED,
        files: { "latethrow.test.js": LATE_THROW },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(envelope.summary.failed).toBe(5);
      expect(clusterOf(envelope, "latethrow.test.js")?.error_kind).toBe("RUNTIME_EXCEPTION");
    },
  );
});

/** Runs the cart with `file` unreadable (mode 000), then restores it so the temp dir can be removed. */
async function withUnreadable(file: string, args: CartArgs, options: CartOptions): Promise<JsonRun> {
  let unreadable = "";
  try {
    return await runJson(
      (dir) => {
        unreadable = path.join(dir, file);
        fs.chmodSync(unreadable, 0o000);
        return typeof args === "function" ? args(dir) : args;
      },
      { ...options, flags: RED },
    );
  } finally {
    if (unreadable !== "") fs.chmodSync(unreadable, 0o644);
  }
}

const itUnlessRoot = it.skipIf(process.getuid?.() === 0);

interface ReadFailure {
  titles: Readonly<Record<Reporter, string>>;
  unreadable: string;
  entry: string;
  files: Readonly<Record<string, string>>;
  /** The test file's own read failed: no test ran. Any other read failure is a runtime error of a test that ran. */
  noTestRan: boolean;
}

const READ_FAILURES: readonly ReadFailure[] = [
  {
    titles: {
      tap: "An unreadable test file is INVALID_RED with exit 64",
      spec: "An unreadable test file is INVALID_RED with exit 64 under the spec reporter",
    },
    unreadable: "noread.test.js",
    entry: "noread.test.js",
    files: { "noread.test.js": source("import test from 'node:test';", "test('x', () => {});") },
    noTestRan: true,
  },
  {
    titles: {
      tap: "A read failure of another file at load stays a behavioural red",
      spec: "A read failure of another file at load stays a behavioural red under the spec reporter",
    },
    unreadable: "secret.txt",
    entry: "loadsecret.test.js",
    files: {
      "secret.txt": "hidden\n",
      "loadsecret.test.js": source(
        "import fs from 'node:fs';",
        "import test from 'node:test';",
        "fs.readFileSync(new URL('./secret.txt', import.meta.url));",
        "test('uses it', () => {});",
      ),
    },
    noTestRan: false,
  },
  {
    titles: {
      tap: "A read failure of a sibling file whose name starts like the test file stays a behavioural red",
      spec: "A read failure of a sibling file whose name starts like the test file stays a behavioural red under the spec reporter",
    },
    unreadable: "cfg.test.json",
    entry: "cfg.test.js",
    files: {
      "cfg.test.json": "{}\n",
      "cfg.test.js": source(
        "import fs from 'node:fs';",
        "import test from 'node:test';",
        "fs.readFileSync(new URL('./cfg.test.json', import.meta.url));",
        "test('x', () => {});",
      ),
    },
    noTestRan: false,
  },
];

describe("node --test, a file the runner cannot read", () => {
  for (const { titles, unreadable, entry, files, noTestRan } of READ_FAILURES) {
    for (const reporter of REPORTERS) {
      itUnlessRoot(titles[reporter], async () => {
        const { run, envelope } = await withUnreadable(unreadable, [...reporterFlag(reporter), entry], {
          files,
        });

        expect(run.code).toBe(noTestRan ? 64 : 0);
        expect(envelope.status).toBe(noTestRan ? "INVALID_RED" : "VALID_RED");
        expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual([
          noTestRan ? "SYNTAX_IMPORT_ERROR" : "RUNTIME_EXCEPTION",
        ]);
        expect(clustersOf(envelope)[0]?.message.startsWith("Error: EACCES: permission denied")).toBe(true);
      });
    }
  }
});

describe("node --test, an unreadable test file reached through a symlinked directory", () => {
  for (const reporter of REPORTERS) {
    itUnlessRoot(
      `An unreadable test file reached through a symlinked directory is INVALID_RED (${reporter})`,
      async () => {
        let link = "";
        try {
          const { run, envelope } = await withUnreadable(
            "noread.test.js",
            (dir) => {
              link = `${dir}-link`;
              fs.symlinkSync(dir, link);
              return [...reporterFlag(reporter), path.join(link, "noread.test.js")];
            },
            { files: { "noread.test.js": source("import test from 'node:test';", "test('x', () => {});") } },
          );

          expect(run.code).toBe(64);
          expect(envelope.status).toBe("INVALID_RED");
          expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["SYNTAX_IMPORT_ERROR"]);
        } finally {
          if (link !== "") fs.rmSync(link, { force: true });
        }
      },
    );
  }
});
