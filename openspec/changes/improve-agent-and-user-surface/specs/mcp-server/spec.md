## ADDED Requirements

### Requirement: mcp serves four tools over stdio, and nothing else on stdout
`dot-test-digest mcp [--allow "<word> <word>"]...` SHALL run a Model Context Protocol server on stdin and stdout, using the official SDK loaded only by this subcommand. Every byte written to stdout SHALL be MCP protocol traffic; logs and warnings go to stderr. The server SHALL list exactly the tools `run_tests`, `show_log`, `replay` and `list_runs`. A normal digest run of the tool without `mcp` SHALL NOT load the SDK.

#### Scenario: The tool list
- **GIVEN** the server spawned as `node dist/index.js mcp` and connected with the SDK client
- **WHEN** the client calls `tools/list`
- **THEN** the tool names are `run_tests`, `show_log`, `replay`, `list_runs`, each with an input schema

#### Scenario: Stdout carries only protocol messages
- **GIVEN** the same server and a transcript of everything it wrote to stdout during a `run_tests` and a `show_log` call
- **WHEN** each line of the transcript is parsed
- **THEN** every line is a JSON-RPC message (`jsonrpc` `"2.0"`)

#### Scenario: A normal run does not load the SDK
- **GIVEN** the build with `--import` of a hook that records module loads
- **WHEN** `-- node --test passing.test.js` runs
- **THEN** no module path contains `@modelcontextprotocol`

### Requirement: run_tests runs only commands the user allowed
`run_tests` takes `command` (argv array, never a shell string), optional `cwd`, `format` (`compact-md` or `json`), `max_clusters`, `context_lines`, `tdd_phase` and `timeout_seconds` (default 300, at most 3600). The command SHALL run only when its leading elements equal, element by element, one of the allowed prefixes; the allowlist is the union of the user config's `mcp.allow` and the `--allow` arguments (each split on single spaces). The default allowlist is empty. `cwd` SHALL resolve (symlinks followed) to the server's working directory or below it. A command that is not allowed, or a `cwd` outside, SHALL return `isError: true` with text `command not allowed: <argv joined by spaces>; allowed prefixes: <list or none>` (or `cwd outside the project: <cwd>`) and start no process. An allowed run returns the same text the CLI would print as `content[0].text`, and `structuredContent` `{ run_id, status, exit_code }`; a failing test run is NOT an error (`isError` false). When `timeout_seconds` elapses the child gets SIGTERM, then SIGKILL after 5 seconds, and the result has `isError: true` and the text `timed out after <N>s` followed by the digest of what was printed.

#### Scenario: The default allowlist is empty
- **GIVEN** the server started as `mcp` with no user config
- **WHEN** `run_tests` is called with `command` `["node","--test","passing.test.js"]`
- **THEN** the result has `isError` true, the text contains `command not allowed: node --test passing.test.js; allowed prefixes: none`, and no log was created

#### Scenario: An allowed command runs and returns the digest
- **GIVEN** the server started as `mcp --allow "node --test"` with the cart as its working directory
- **WHEN** `run_tests` is called with `["node","--test","passing.test.js"]`
- **THEN** `isError` is false, the text starts `[PASS] 1 passed, 0 failed in `, and `structuredContent` is `{ "run_id": "<run>", "status": "PASS", "exit_code": 0 }`

#### Scenario: A failing test run is a result, not an error
- **GIVEN** the same server
- **WHEN** `run_tests` is called with `["node","--test","cart.test.js"]` and `format` `"compact-md"`
- **THEN** `isError` is false, `structuredContent.exit_code` is `1`, and the text is the digest with a `next:` line

#### Scenario: Prefix matching is element-wise
- **GIVEN** the server started as `mcp --allow "node --test"`
- **WHEN** `run_tests` is called with `["node","--testx"]`, with `["node"]`, and with `["sh","-c","node --test"]`
- **THEN** all three return `isError` true and start no process

#### Scenario: No shell is involved
- **GIVEN** the server started as `mcp --allow "node --test"`
- **WHEN** `run_tests` is called with `["node","--test","a.test.js; touch /tmp/pwned"]`
- **THEN** no file `/tmp/pwned` is created (the argument is passed to node as one filename)

#### Scenario: A working directory outside the project is refused
- **GIVEN** the server started as `mcp --allow "node --test"` in the cart
- **WHEN** `run_tests` is called with `cwd` `".."` and with `cwd` a symlink inside the cart that points to `/tmp`
- **THEN** both return `isError` true with text starting `cwd outside the project:`

#### Scenario: The user config extends the allowlist
- **GIVEN** a user config `{ "mcp": { "allow": [["pnpm","test"]] } }` and a server started with `mcp --allow "node --test"`
- **WHEN** `run_tests` is called with `["pnpm","test"]` and with `["node","--test","passing.test.js"]`
- **THEN** both are allowed (the first may fail to start `pnpm`, but not with `command not allowed`)

#### Scenario: A project file cannot extend the allowlist
- **GIVEN** a project file `.dot-test-digest.json` `{ "mcp": { "allow": [["node"]] } }` and a server started as `mcp` with no user config
- **WHEN** `run_tests` is called with `["node","--test","passing.test.js"]`
- **THEN** it is refused (`allowed prefixes: none`) and the server's stderr contains `ignoring "mcp" in`

#### Scenario: The timeout stops the child
- **GIVEN** the server started as `mcp --allow "sleep"`
- **WHEN** `run_tests` is called with `["sleep","30"]` and `timeout_seconds` `1`
- **THEN** the result arrives in under 10 seconds with `isError` true, the text starts `timed out after 1s`, and no `sleep` process of the call remains

### Requirement: show_log, replay and list_runs give an agent the rest of the story
`show_log` SHALL take `run` (a run reference) and an optional `selector` (a range or cluster id) and return what `show` prints. `replay` SHALL take `run` and the replay options and return what `replay` prints. `list_runs` SHALL take an optional `limit` (default 10, at most 50) and return the newest runs of the server's working directory, one per line: `<run_id> <status> <created_at> <command joined by spaces>`; these three tools need no allowlist and run no command. Errors SHALL use `isError: true` with the message the CLI prints.

#### Scenario: show_log returns a range
- **GIVEN** a cart run made through `run_tests` as above
- **WHEN** `show_log` is called with `run` `"last"` and `selector` `"L15-L17"`
- **THEN** the text is lines 15 to 17 of the log

#### Scenario: replay returns JSON
- **GIVEN** the same run
- **WHEN** `replay` is called with `run` `"last"`, `format` `"json"` and `max_clusters` `15`
- **THEN** the text parses as JSON with `summary.total_clusters` `4`

#### Scenario: list_runs is newest first
- **GIVEN** two runs made through `run_tests` (`passing.test.js`, then `cart.test.js`)
- **WHEN** `list_runs` is called with `limit` `5`
- **THEN** the text has 2 lines, the first for the `cart.test.js` run with status `FAIL`, the second for the `passing.test.js` run with status `PASS`

#### Scenario: A bad reference is an error result
- **GIVEN** the server running
- **WHEN** `show_log` is called with `run` `"run_zzzzzz"`
- **THEN** `isError` is true and the text is `no such run: run_zzzzzz`

### Requirement: init can print the MCP client entry
`init --print-mcp-config` SHALL print, without writing any file, the JSON `{"mcpServers":{"dot-test-digest":{"command":"dot-test-digest","args":["mcp"]}}}` formatted with two-space indentation, and exit `0`. The allowlist is not part of it (it belongs to the user's own config).

#### Scenario: The MCP client snippet
- **GIVEN** any directory
- **WHEN** `init --print-mcp-config` runs
- **THEN** stdout is that JSON followed by a newline, and no file was created
