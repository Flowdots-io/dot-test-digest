import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { hermeticEnv } from "./hermetic-env.js";

// Vitest setup file: also covers tests that call `main` without deps or spawn the binary.
const kept = hermeticEnv();
for (const name of Object.keys(process.env)) {
  if (!(name in kept)) delete process.env[name];
}
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-xdg-empty-"));
process.env["XDG_CONFIG_HOME"] = configHome;
afterAll(() => fs.rmSync(configHome, { recursive: true, force: true }));
