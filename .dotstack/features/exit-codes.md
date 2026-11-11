# Exit-code transparency

The wrapper exits with exactly the child's exit code, so CI and scripts can keep using it as a drop-in. A child killed by a signal gives `128 + signal`. The only deliberate differences are the TDD gate's `64` and usage errors.

## Sub-features

- `exit-passthrough` a child exiting with any code `0..255` gives that code.
- `exit-signal` a child killed by `SIGTERM` gives `143`.
- `exit-missing-command` a command that does not exist gives `127`.
- `exit-test-failure` a failing test run gives the runner's own code (`node --test` exits `1`, `tsc` exits `2`).

## How to get to it (user POV)

- Run any command through `dot-test-digest -- <command>` and read `$?`.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: not safe (each child run writes a raw log under the run's isolated cache home).

- **Arbitrary code.** `$V drive $RUN exit42 - -- sh -c 'exit 42'`. `exit.txt` is `42`. The digest header is `[BUILD_ERROR] 0 failed, 0 passed ... | 1 cluster` because no grammar recognises the output; the status does not change the code.
- **Signal.** `$V drive $RUN term - -- sh -c 'kill -TERM $$'`. `exit.txt` is `143`.
- **Missing command.** `$V drive $RUN nocmd - -- definitely-not-a-command`. `exit.txt` is `127`, stdout is empty, stderr is `dot-test-digest: spawn definitely-not-a-command ENOENT`.
- **Test runner failure.** `$V drive $RUN nodefail node-cart -- node --test cart.test.js` gives `1`; `$V drive $RUN tsc tsc-small -- tsc --noEmit` gives `2`.
- **Pass.** `$V drive $RUN nodepass node-cart -- node --test passing.test.js` gives `0`.
- **Second view.** In every case the code in `evidence/<label>/exit.txt` equals what the same command gives without the wrapper: run it by hand in the fixture copy (`cd $(cat .acceptance/verify/$RUN/workdir)/node-cart && node --test cart.test.js; echo $?`).

## Gotchas

- `verify.sh drive` reports the wrapper's exit code, not the shell's last command: read `exit.txt`, not the echoed `$?` of a pipe.
- Under a pipe (`... | head`), `$?` is the last command's; use `${PIPESTATUS[0]}`.
- `sh -c 'kill -TERM $$'` needs a POSIX shell; the code is `128 + 15`.
