import fs from "node:fs";
import path from "node:path";

/** The caller's settings and color preference must never reach a test; `DOT_TEST_DIGEST_HOME` is the test's own. */
export function hermeticEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => name === "DOT_TEST_DIGEST_HOME" || !(name.startsWith("DOT_TEST_DIGEST_") || name === "NO_COLOR"),
    ),
  );
}

/** A fixture copy is its own repository, so the project-file walk stops inside it. */
export function markRepositoryRoot(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}
