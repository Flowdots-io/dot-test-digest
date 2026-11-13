# MCP server

`dot-test-digest mcp [--allow "<word> <word>"]...` serves the tools `run_tests`, `show_log`, `replay` and `list_runs` over the Model Context Protocol on stdin and stdout until stdin ends, answers the calls still running, then exits `0`. stdout carries only JSON-RPC messages (one per line); warnings and run diagnostics go to stderr. `run_tests` runs a command only when its argv starts, element by element, with an allowed prefix; the allowlist is the user config's `mcp.allow` plus the `--allow` arguments, empty by default, never read from a project file. `init --print-mcp-config` prints the client entry.

## Sub-features

- `mcp-tools` `tools/list` returns `run_tests`, `show_log`, `replay`, `list_runs` in that order, each with an object input schema; `run_tests` also has an output schema `{ run_id, status, exit_code }`.
- `mcp-stdout` every stdout line parses as JSON with `"jsonrpc":"2.0"`; nothing else is printed there. A normal wrapped run never loads `@modelcontextprotocol/sdk`.
- `mcp-allow` `--allow` takes words separated by single spaces (an empty word, `""` or two spaces, is exit `64`); any other argument is exit `64` `unexpected argument "<arg>": dot-test-digest mcp [--allow "<word> <word>"]...`. A refused command is `isError` with `command not allowed: <argv joined by spaces>; allowed prefixes: <prefixes joined by ", "|none>` and starts no process (no log is created). Not a sandbox: a prefix allows any later arguments, so an allowed runner can load arbitrary code (`node --test --import=data:text/javascript,... x.test.js`); a relative prefix (`./gradlew`) resolves against the run's `cwd`.
- `mcp-project-file` a project `.dot-test-digest.json` with an `mcp` key: the key is ignored and stderr has `dot-test-digest: ignoring "mcp" in <file>: the command allowlist is read from the user config only`.
- `mcp-run` an allowed `run_tests` returns the digest the CLI would print as `content[0].text`, `structuredContent` `{ run_id, status, exit_code }`, `isError` false also for a failing run. `format` (`compact-md`, `json`), `max_clusters`, `context_lines`, `tdd_phase` become the CLI flags; the rest comes from the configuration. No shell: `["node","--test","a.test.js; touch x"]` passes one file name to node.
- `mcp-cwd` `cwd` is relative to the server's directory; its real path (symlinks followed) must be that directory or below, else `cwd outside the project: <cwd>`; a missing one is `cwd not found: <cwd>`. The child runs in the real path.
- `mcp-timeout` `timeout_seconds` (default 300, 1 to 3600): SIGTERM to the child's process group, SIGKILL 5 s later (and to what is left of the group when the child exits); `isError` true, text `timed out after <N>s` then the digest of what was printed (`sleep` printed nothing: `[BUILD_ERROR] 0 failed, 0 passed ...`, exit code `143`).
- `mcp-stop` on SIGTERM, SIGINT or SIGHUP the server SIGKILLs the process groups of its running commands, then exits `128 + signal`. A `rerun` hint of a run with `cwd` `sub` is relative to `sub` (`node --test --test-name-pattern '^fails$' a.test.js`).
- `mcp-read` `show_log` (`run`, `selector`) returns what `show` prints, `replay` (`run`, `format`, `max_clusters`, `context_lines`) what `replay` prints, `list_runs` (`limit`, default 10, at most 50) the newest runs recorded with the server's directory as `cwd`, `<run_id> <status> <created_at> <command>` per line (`no run recorded for this directory` when there is none). Only runs recorded in the server's directory or below exist for these tools: an id or prefix of another project in the same cache is `no such run: <ref>`, and an ambiguous prefix lists only this project's ids. A CLI error is `isError` with its message, e.g. `no such run: run_zzzzzz`. A `run` or `selector` starting with `-` is refused.
- `mcp-snippet` `init --print-mcp-config` prints `{"mcpServers":{"dot-test-digest":{"command":"dot-test-digest","args":["mcp"]}}}` with two-space indentation and a newline, exit `0`, no file written; with `--force` it is exit `64`.

## How to get to it (user POV)

- `dot-test-digest init --print-mcp-config`, paste the entry into the MCP client's configuration (add `"--allow", "pnpm test"` to `args`, or put `{ "mcp": { "allow": [["pnpm","test"]] } }` in `~/.config/dot-test-digest/config.json`), start the client in the project, and let the agent call `run_tests`.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test. `W=$(cat .acceptance/verify/$RUN/workdir)`; `mkdir -p $W/node-cart/.git` (so a project file there is found).
- A session is JSON-RPC lines piped into `drive` (stdin passes through). Define:
  `INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'; NOTE='{"jsonrpc":"2.0","method":"notifications/initialized"}'; call() { printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2" "$3"; }`
- Prod: not safe (`run_tests` writes logs and records into the run's home).

- **Session.** `printf '%s\n' "$INIT" "$NOTE" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$(call 3 run_tests '{"command":["node","--test","passing.test.js"]}')" "$(call 4 run_tests '{"command":["node","--test","cart.test.js"]}')" | $V drive $RUN mcp-session node-cart mcp --allow "node --test"`. Exit `0`; stdout is 4 JSON lines: id 2 lists the four tools; id 3 `structuredContent` `{"run_id":"run_...","status":"PASS","exit_code":0}`, text `[PASS] 1 passed, 0 failed in <t>ms | log: ...`; id 4 `isError` false, `exit_code` 1, text starts `[FAIL] 4 failed, 2 passed in` and line 2 is `next: dot-test-digest show run_... c_...`. Second view: `jq -c .jsonrpc .acceptance/verify/$RUN/evidence/mcp-session/stdout.txt` prints only `"2.0"`.
- **Read the runs.** (After Session.) `printf '%s\n' "$INIT" "$NOTE" "$(call 2 list_runs '{"limit":5}')" "$(call 3 show_log '{"run":"last","selector":"L15-L17"}')" "$(call 4 replay '{"run":"last","format":"json","max_clusters":15}')" "$(call 5 show_log '{"run":"run_zzzzzz"}')" | $V drive $RUN mcp-read node-cart mcp`. id 2: two lines, the `cart.test.js` run `FAIL` first, the `passing.test.js` run `PASS` second; id 3: lines 15 to 17 of that log (`not ok 3 - discount 10% leaves 90%`, `  ---`, `  duration_ms: ...`); id 4: JSON with `"total_clusters": 4`; id 5: `isError` true, `no such run: run_zzzzzz`.
- **Default refuses.** `printf '%s\n' "$INIT" "$NOTE" "$(call 2 run_tests '{"command":["node","--test","passing.test.js"]}')" | $V drive $RUN mcp-none node-cart mcp`: `isError` true, `command not allowed: node --test passing.test.js; allowed prefixes: none`.
- **Prefix and cwd.** `printf '%s\n' "$INIT" "$NOTE" "$(call 2 run_tests '{"command":["sh","-c","node --test"]}')" "$(call 3 run_tests '{"command":["node","--test","passing.test.js"],"cwd":".."}')" | $V drive $RUN mcp-refuse node-cart mcp --allow "node --test"`: id 2 `command not allowed: sh -c node --test; allowed prefixes: node --test`; id 3 `cwd outside the project: ..`.
- **Project file ignored.** `echo '{ "mcp": { "allow": [["node"]] } }' > $W/node-cart/.dot-test-digest.json; printf '%s\n' "$INIT" "$NOTE" | $V drive $RUN mcp-project node-cart mcp`: stderr `dot-test-digest: ignoring "mcp" in $W/node-cart/.dot-test-digest.json: the command allowlist is read from the user config only`. Delete the file afterwards.
- **Timeout.** `printf '%s\n' "$INIT" "$NOTE" "$(call 2 run_tests '{"command":["sleep","30"],"timeout_seconds":1}')" | $V drive $RUN mcp-timeout node-cart mcp --allow sleep`: returns in about 1.5 s, `isError` true, text starts `timed out after 1s`, `exit_code` 143. Second view: `ps -eo args= | grep -cx 'sleep 30'` prints `0` (`pgrep -f` would match the shell that runs it).
- **Client snippet.** `$V drive $RUN snippet - init --print-mcp-config`: exit `0`, the JSON above (131 bytes); `ls -A $W` is still `node-cart tsc-small vitest-cart`.

## Gotchas

- Calls in one session run concurrently: a `list_runs` sent with the `run_tests` it should list can answer first. Put a call that reads a run in a later session (as above), or wait for the result as a real client does.
- `drive` writes nothing on stdin for you; without a pipe the server waits on the terminal. End the session by ending stdin.
- `last` and `list_runs` see only runs recorded with the server's directory as `cwd`; a `run_tests` with a `cwd` below it records that directory.
- The `run_tests` text is the CLI's digest of a pipe: `color: auto` never colors it.
- The Claude Code hook half of the design is not built (see the change's design.md, "Defaults chosen").
