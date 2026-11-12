# Configuration and color

Every setting that a flag sets per run can also come from a `DOT_TEST_DIGEST_*` environment variable, the nearest `.dot-test-digest.json` project file, or the user file `$XDG_CONFIG_HOME/dot-test-digest/config.json`, in that order after the flag; `dot-test-digest config` prints the effective value of each and where it came from. A bad file or variable is a usage error (exit 64) before the child starts. `--color` (or the `color` setting) colors the status word of the header on a terminal.

## Sub-features

- `config-layers` flag, then environment, then project file, then user file, then default, per setting (`maxClusters`, `contextLines`, `format`, `noJev`, `retryFlakes`, `color`, `progress`, `retention.auto`, `retention.keepRuns`, `retention.maxAgeDays`, `retention.stateMaxAgeDays`, `mcp.allow`).
- `config-discovery` the project file is the nearest `.dot-test-digest.json` walking up to the first directory holding `.git` (inclusive), never above the home directory; parent files are not merged.
- `config-subcommand` `config` prints `<key> = <value> (<source>)` per setting, the source `default`, `user <path>`, `project <path>` or `env <NAME>`; `mcp.allow` only when set.
- `config-strict` an unknown key, a bad value or malformed JSON exits 64 naming the file (or variable) and the key.
- `config-mcp-trust` a project file's `mcp` key is ignored with one stderr warning; `mcp.allow` comes from the user file only.
- `terminal-color` `--color auto|always|never`: green `PASS`/`VALID_RED`, red for every other status, only the status word; `auto` needs a terminal, no `NO_COLOR`, `TERM` not `dumb`; JSON is never colored.

## How to get to it (user POV)

- Put `{ "maxClusters": 1 }` in `.dot-test-digest.json` at the repository root and run any failing command through `dot-test-digest -- ...`.
- Run `dot-test-digest config` in the project to see what applies and why.
- Run in a terminal: the status word is green or red; pipe it (`| cat`) or set `NO_COLOR=1` and it is plain.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test and a `user config:` path inside the run (the driver sets `XDG_CONFIG_HOME` to `.acceptance/verify/$RUN/xdg`, so your own `~/.config` never applies).
- `W=$(cat .acceptance/verify/$RUN/workdir)`: the fixture copies, outside any git repository. Write project files into `$W/node-cart` only, and delete them after the journey that needs them.
- Prod: not safe (the wrapped runs write logs in the run's `home/`; `config` itself writes nothing).

- **Defaults.** `$V drive $RUN defaults node-cart config`. Exit `0`; stdout is exactly 11 lines, from `maxClusters = 5 (default)` to `retention.stateMaxAgeDays = 90 (default)`; stderr empty. (Unset any `DOT_TEST_DIGEST_*` variable in your shell first: the driver passes the environment through.)
- **Project file.** `echo '{ "maxClusters": 1 }' > $W/node-cart/.dot-test-digest.json`, then `$V drive $RUN proj node-cart -- node --test cart.test.js`. Exit `1`; the header contains `| 1 cluster |` and the digest has `+3 more clusters (see log)`. Second view: `$V drive $RUN projcfg node-cart config` prints `maxClusters = 1 (project $W/node-cart/.dot-test-digest.json)`.
- **Env beats file, flag beats env.** With the same file, `DOT_TEST_DIGEST_MAX_CLUSTERS=2 $V drive $RUN envmc node-cart -- node --test cart.test.js` has `| 2 clusters |`; adding `--max-clusters=3` before `--` gives `| 3 clusters |`.
- **User file.** `mkdir -p .acceptance/verify/$RUN/xdg/dot-test-digest && echo '{ "maxClusters": 4, "contextLines": 0 }' > .acceptance/verify/$RUN/xdg/dot-test-digest/config.json`, then `config` with the project file still present: `maxClusters = 1 (project …)` and `contextLines = 0 (user …/xdg/dot-test-digest/config.json)`.
- **Env names.** `DOT_TEST_DIGEST_FORMAT=json DOT_TEST_DIGEST_PRUNE=0 $V drive $RUN envcfg node-cart config` prints `format = json (env DOT_TEST_DIGEST_FORMAT)` and `retention.auto = false (env DOT_TEST_DIGEST_PRUNE)`.
- **Strict.** Project file `{ "maxCluster": 3 }`: `$V drive $RUN unknown node-cart -- true` exits `64`, stderr `<W>/node-cart/.dot-test-digest.json: unknown key "maxCluster"`. `{ "maxClusters": 99 }`: stderr `…: maxClusters must be between 1 and 15, got 99`. `{ "maxClusters": ` (truncated): stderr starts `…: invalid JSON:`. No file and `DOT_TEST_DIGEST_MAX_CLUSTERS=abc`: stderr `DOT_TEST_DIGEST_MAX_CLUSTERS must be an integer between 1 and 15, got abc`. In each, no new `run_*.log` appears in `home/logs` (the child never started).
- **MCP trust.** Project file `{ "mcp": { "allow": [["rm"]] } }` and user file `{ "mcp": { "allow": [["pnpm", "test"]] } }`: `config` exits `0`, prints `mcp.allow = [["pnpm","test"]] (user …)`, and stderr is exactly `dot-test-digest: ignoring "mcp" in <W>/node-cart/.dot-test-digest.json: the command allowlist is read from the user config only`.
- **Color always.** (No project file.) `$V drive $RUN colpass node-cart --color=always -- node --test passing.test.js`: `head -c 20 evidence/colpass/stdout.txt | od -c` shows `[ 033 [ 3 2 m P A S S 033 [ 0 m ]`. `cart.test.js` instead: `033 [ 3 1 m F A I L`.
- **Color stripped.** `sed 's/\x1b\[[0-9;]*m//g'` of the colored cart output equals a `--color=never` cart run once `in <n>ms` and the run id are masked.
- **Auto in a pipe.** `$V drive $RUN colauto node-cart -- node --test passing.test.js`: stdout has no `033` byte (the driver redirects stdout to a file, which is not a terminal). For the terminal case run the built binary by hand in a real terminal: green `PASS`; with `NO_COLOR=1` plain; with `NO_COLOR=1 --color=always` green.
- **JSON plain.** `--color=always --format=json -- node --test passing.test.js`: no `033` byte, and `jq .` parses it.
- **Bad value.** `$V drive $RUN colbad - --color=blue -- true`. Exit `64`; stderr `--color must be auto, always or never`.

## Gotchas

- The driver passes your shell's environment through: a `DOT_TEST_DIGEST_*` or `NO_COLOR` variable you exported changes the result. Use `env -u` or a clean shell.
- `verify.sh drive` inserts `--no-jev` before your flags, so `noJev` always reads as the flag in a wrapped run; `config` gets no `--no-jev` (it is a subcommand) and shows the file or default value.
- The fixture copies live under `/tmp` with no `.git` above them, so the project-file walk goes to `/`; a stray `/tmp/.dot-test-digest.json` would be found.
- `ndjson` is not a `format` value until the JSON contract slice lands; until then `"format": "ndjson"` is a usage error.
- A user file you write under `xdg/` stays for the rest of the run; delete it before the Defaults journey.
