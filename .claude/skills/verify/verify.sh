#!/usr/bin/env bash
# Driver for verifying dot-test-digest through its real CLI. See SKILL.md.
#   verify.sh launch            build the commit under test into a scratch dir, print RUN
#   verify.sh doctor  <RUN>     read-only: is this build the commit under test?
#   verify.sh drive   <RUN> <label> <fixture|-> [digest flags] -- <command ...>
#   verify.sh cleanup <RUN>     remove build, cache and fixture copies; keep evidence
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROOT="$REPO/.acceptance/verify"

die() { echo "verify.sh: $*" >&2; exit 2; }
run_dir() { [ -n "${1:-}" ] || die "missing RUN"; [ -d "$ROOT/$1" ] || die "no such run: $1"; echo "$ROOT/$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  launch)
    command -v node >/dev/null || die "node not on PATH (needs >= 20)"
    RUN="v$(date +%s)-$$"
    D="$ROOT/$RUN"
    mkdir -p "$D"/{build,home,evidence}
    W="$(mktemp -d "${TMPDIR:-/tmp}/dtd-verify-XXXXXX")"   # outside the repo: vitest walks up looking for a config
    echo "$W" >"$D/workdir"
    (cd "$REPO" && node_modules/.bin/tsc -p tsconfig.json --outDir "$D/build" >"$D/evidence/build.log" 2>&1) \
      || { cat "$D/evidence/build.log" >&2; die "build failed"; }
    git -C "$REPO" rev-parse HEAD >"$D/commit"
    git -C "$REPO" status --porcelain | grep -q . && echo dirty >>"$D/commit" || true
    for f in node-cart tsc-small vitest-cart; do cp -r "$REPO/tests/fixtures/$f" "$W/$f"; done
    ln -s "$REPO/node_modules" "$W/vitest-cart/node_modules"
    echo "$RUN"
    ;;
  doctor)
    D="$(run_dir "${1:-}")"
    echo "run:         $1"
    echo "commit:      $(tr '\n' ' ' <"$D/commit")(HEAD now: $(git -C "$REPO" rev-parse HEAD))"
    echo "node:        $(node --version)"
    echo "cache home:  $D/home (not the user's ~/.cache)"
    echo "user config: $D/xdg/dot-test-digest/config.json (not the user's ~/.config)"
    echo "fixtures:    $(cat "$D/workdir")"
    echo "binary:      $D/build/index.js"
    echo "version:     $(node "$D/build/index.js" --version)"
    [ "$(head -1 "$D/commit")" = "$(git -C "$REPO" rev-parse HEAD)" ] || echo "WARNING: build is not the current HEAD; run cleanup and launch again" >&2
    ;;
  drive)
    D="$(run_dir "${1:-}")"; label="${2:-}"; fixture="${3:-}"; shift 3 || die "usage: drive RUN label fixture [flags] -- command"
    [ -n "$label" ] || die "missing label"
    cwd="$(cat "$D/workdir")"; [ "$fixture" = "-" ] || cwd="$cwd/$fixture"
    [ -d "$cwd" ] || die "no such fixture: $fixture"
    out="$D/evidence/$label"
    mkdir -p "$out"
    printf '%s\n' "(cd $fixture; dot-test-digest $*)" >"$out/command.txt"
    # A subcommand must be the first word, so it gets no --no-jev in front (none of them calls Jev uninvited).
    case "${1:-}" in
      show|replay|digest|gc|stats|doctor|init|mcp|config|schema) offline=() ;;
      *) offline=(--no-jev) ;;
    esac
    set +e
    (cd "$cwd" && DOT_TEST_DIGEST_HOME="$D/home" XDG_CONFIG_HOME="$D/xdg" PATH="$REPO/node_modules/.bin:$PATH" \
       node "$D/build/index.js" "${offline[@]}" "$@" >"$out/stdout.txt" 2>"$out/stderr.txt")
    echo $? >"$out/exit.txt"
    set -e
    echo "== $label: exit $(cat "$out/exit.txt"), $(wc -c <"$out/stdout.txt") bytes on stdout"
    cat "$out/stdout.txt"
    [ ! -s "$out/stderr.txt" ] || { echo "-- stderr:"; cat "$out/stderr.txt"; }
    ;;
  cleanup)
    D="$(run_dir "${1:-}")"
    rm -rf "$D/build" "$D/home" "$D/xdg" "$(cat "$D/workdir")" "$D/workdir"
    echo "removed build, cache home and fixture copies; evidence kept in $D/evidence"
    ;;
  *) die "usage: verify.sh launch | doctor RUN | drive RUN label fixture [flags] -- cmd | cleanup RUN" ;;
esac
