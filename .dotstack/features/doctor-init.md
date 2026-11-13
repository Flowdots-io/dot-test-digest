# Doctor and init

`doctor [--json]` checks the setup in the working directory and prints one line per check, `ok`, `warn` or `fail`, then the check name and its detail: `node`, `version`, `cache`, `config`, `gear1`, and one `runner` line per runner it detects, with the command to wrap. It exits `0` unless a check failed (`1`), never writes a file and never calls the network. `init [--force]` writes a starter `.dot-test-digest.json` in the working directory and refuses to overwrite one without `--force`; `init --print-mcp-config` prints the MCP client entry and writes nothing (see [mcp.md](./mcp.md)).

## Sub-features

- `doctor-lines` each line is the status padded to six characters, then `<name>: <detail>`: `ok    node: v22.23.4 (>= 20)` (`fail` below 20), `ok    version: <version>`, `ok    cache: <home> (writable, <n> runs, <k> KiB)`, `ok    config: none found` or the files found (`project <path>`, `user <path>`), `warn  gear1: TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)` or `ok    gear1: TYPESAFE_API_KEY is set`.
- `doctor-runners` `vitest`, `jest`, `mocha`, `eslint` from a dependency in `package.json`; `node --test` from a `scripts.test` containing `node --test`; `pytest` from `pytest.ini`, or `pyproject.toml`/`setup.cfg` mentioning pytest; `cargo` (`Cargo.toml`), `go` (`go.mod`), `tsc` (`tsconfig.json`). Line: `ok    runner: vitest (package.json) -> dot-test-digest -- npx vitest run`. `warn` with `(no grammar; heuristic fallback)` for mocha and `(grammar checked against fixtures only)` for jest, pytest, cargo, go and eslint. No runner: `warn  runner: none detected (wrap your own command: dot-test-digest -- <command>)`.
- `doctor-json` `--json` prints one line `{"ok":..,"checks":[{"name","status","detail"},..],"runners":[{"name","status","source","command","note"?},..]}`; `command` is the whole wrapped command (`dot-test-digest -- npx jest`).
- `doctor-fail` an invalid config file is `fail  config: <path>: unknown key "maxCluster"` (the message a run would exit 64 with); a cache directory that cannot be created or written (for example under a regular file) is `fail  cache: <home> (not a directory: <file>)`; an entry in the cache it cannot read is `fail  cache: <home> (cannot read <path>: EACCES)` (an entry removed meanwhile is skipped); each makes the exit `1`, never `70`.
- `doctor-secret` the value of `TYPESAFE_API_KEY` (or `JEV_API_KEY`) is never printed, in text or JSON.
- `doctor-gear1` the key rule of a run: `TYPESAFE_API_KEY` first, then `JEV_API_KEY`; an empty `TYPESAFE_API_KEY` wins and is `warn  gear1: TYPESAFE_API_KEY is empty (Jev disabled; heuristic fallback)`; `noJev` true in the config is `warn  gear1: Jev disabled by noJev (<source>); heuristic fallback` whatever the key.
- `doctor-warnings` a malformed `package.json` is `warn  runner: package.json is not valid JSON` (or `is not a JSON object`), other runners are still listed; a config warning (a project `mcp` key, a project retention limit) is a `warn  config: ignoring ...` line, not a stderr line.
- `doctor-readonly` nothing is written: a cache home that does not exist yet is reported `ok` (it can be created) and still does not exist afterwards.
- `init-write` `init` writes `{\n  "maxClusters": 5,\n  "contextLines": 2,\n  "format": "compact-md",\n  "noJev": false\n}\n`, prints `wrote <dir>/.dot-test-digest.json`, exits `0`, and writes no other file.
- `init-keep` an existing file exits `64` with `<path> already exists (use --force to overwrite)` on stderr and is left untouched; `init --force` overwrites it. Any other argument exits `64` `unexpected argument "<arg>": dot-test-digest init [--force | --print-mcp-config]`.
- `init-link` a symlink at the path: `init` exits `64` `<path> is a symlink (use --force to replace the link)`; `init --force` removes the link and writes a new file, the link's target unchanged. A directory there exits `64` `<path> is a directory` (also with `--force`). A read-only working directory exits `73` `cannot create <path>: EACCES`.

## How to get to it (user POV)

- In a new project, `dot-test-digest doctor` to see whether Node, the cache and the config are fine and which command to wrap; `dot-test-digest init` to get a config file to edit; `dot-test-digest config` to see it apply.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test (that is the driver's own `doctor`, not this subcommand). `W=$(cat .acceptance/verify/$RUN/workdir)`, `H=.acceptance/verify/$RUN/home`.
- `unset TYPESAFE_API_KEY JEV_API_KEY` in your shell first (the driver passes the environment through).
- Prod: not safe (`init` writes `.dot-test-digest.json` into the fixture copy; `doctor` writes nothing).

- **Vitest project.** `$V drive $RUN vit vitest-cart doctor`. Exit `0`; stdout is the six lines `ok    node: v22.23.4 (>= 20)`, `ok    version: 0.2.0`, `ok    cache: <abs $H> (writable, 0 runs, 0 KiB)`, `ok    config: none found`, `warn  gear1: TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)`, `ok    runner: vitest (package.json) -> dot-test-digest -- npx vitest run`. Second view: `ls -A $H` before and after is the same.
- **JSON.** `$V drive $RUN tscj tsc-small doctor --json`. Exit `0`; one JSON line, `ok` true, `runners` is `[{"name":"tsc","status":"ok","source":"tsconfig.json","command":"dot-test-digest -- npx tsc --noEmit"}]`.
- **No runner.** `$V drive $RUN cart node-cart doctor`: the last line is `warn  runner: none detected (wrap your own command: dot-test-digest -- <command>)` (its `package.json` is only `{"type":"module"}`); exit `0`.
- **Key hidden.** `TYPESAFE_API_KEY=sk-secret-123 $V drive $RUN key tsc-small doctor`. The gear1 line is `ok    gear1: TYPESAFE_API_KEY is set`; `grep -c sk-secret .acceptance/verify/$RUN/evidence/key/std*` is `0` for both files.
- **Bad config.** `mkdir -p $W/node-cart/.git; echo '{ "maxCluster": 3 }' > $W/node-cart/.dot-test-digest.json`, then `$V drive $RUN bad node-cart doctor`. Exit `1`; stdout contains `fail  config: $W/node-cart/.dot-test-digest.json: unknown key "maxCluster"`. Delete the file afterwards.
- **Init.** (`.git` from the previous journey in place.) `$V drive $RUN init node-cart init`: exit `0`, stdout `wrote $W/node-cart/.dot-test-digest.json`, `cat` of the file is the four keys above. Second view: `$V drive $RUN cfg node-cart config` shows `maxClusters = 5 (project $W/node-cart/.dot-test-digest.json)` and the same source for `contextLines`, `format`, `noJev`.
- **Init again.** `$V drive $RUN init2 node-cart init`: exit `64`, stdout empty, stderr `$W/node-cart/.dot-test-digest.json already exists (use --force to overwrite)`; `$V drive $RUN initf node-cart init --force`: exit `0`. Delete the file afterwards.
- **Symlink.** `echo keep > /tmp/dtd-outside; ln -sf /tmp/dtd-outside $W/node-cart/.dot-test-digest.json`, then `$V drive $RUN link node-cart init`: exit `64`, stderr `$W/node-cart/.dot-test-digest.json is a symlink (use --force to replace the link)`; `$V drive $RUN linkf node-cart init --force`: exit `0`, `cat /tmp/dtd-outside` is still `keep`, `test -L $W/node-cart/.dot-test-digest.json` fails. Delete both files afterwards.

## Gotchas

- The fixture copies live under `/tmp`, outside home and outside any repository: without the `mkdir $W/node-cart/.git`, a `.dot-test-digest.json` there is never found, so `doctor` says `none found` and `config` shows defaults.
- The cache count and size are of the run's `home/`, so they grow with the journeys of other feature files driven in the same launch; `0 runs, 0 KiB` holds only on a fresh launch.
- Runner detection looks at the working directory only, not at parents or subdirectories; a monorepo package is checked from its own directory.
- The `jest`, `pytest`, `cargo`, `go` and `eslint` commands are suggestions checked against fixtures, never run here (see "Not covered" in the README of this directory).
