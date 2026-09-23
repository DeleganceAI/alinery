# Playbooks engine: process ownership verification

This first pass targets the new v2 Playbooks engine at base commit
`9a211d01329e353c4179942df4da39a5ab2f5d3a`. It found two model-checked
concurrency bugs and an analogous stale-completion bug, reproduced them with
Rust regression tests, and includes fixes for all three.

This is **finite-state verification of two source-derived models**, plus tests
of the implementation. It is not a proof that the complete Rust engine refines
the models or that the whole engine is correct. No Lean proof is claimed.

## Findings and fixes

| Finding | Consequence | Fix | Evidence |
| --- | --- | --- | --- |
| Old reader commits exit after same-ID transport replacement | Live replacement is marked stopped and releases execution/coding capacity | Check the captured old process's replacement flag inside the durable exit transaction | `ExitOwnership` counterexample; failing-then-passing Rust callback regression |
| Repository mutation lock is busy when an owner exits | Accepted execution stays `Finishing`, retains capacity, and blocks subsequent work | Retry only the transient lock-busy error, stopping when the captured process is superseded | `ExitDelivery` temporal counterexample; failing-then-passing isolated daemon regression |
| Authenticated completion request resumes after same-ID replacement | Old request accepts outputs on behalf of the replacement | Carry the authenticated process's flag into the completion transaction and check it there | Failing-then-passing Rust completion regression; not separately modeled |

The fixes reuse the existing per-process `replacing` flag and repository mutation
lock. They add no persisted fields, protocol changes, dependencies, or new
background service. The exit retry waits 25 ms between transient failures;
non-contention errors still surface in the daemon log.

## Counterexamples

`ExitOwnership.before.cfg` violates `ShutdownMeansStopped`:

```text
old process reaped and output drained
  -> old reader passes its replacement-flag check
  -> restate sets the old flag and reserves Interrupted
  -> replacement is prepared and starts under the same session ID
  -> old reader commits Failed + shutdown_confirmed=true
     while the replacement is alive
```

`ExitDelivery.before.cfg` violates `ExitEventuallyRecorded`:

```text
unrelated task holds repository mutation lock
  -> child reaped and output drained
  -> durable exit confirmation gets "task mutation busy" and is discarded
  -> unrelated transaction releases lock
  -> no pending notification remains; shutdown is never recorded
```

## Source correspondence

Paths below are relative to `alinery-app/src-tauri/`.

| Model operation/property | Implementation |
| --- | --- |
| `ReapOld`, `CheckExit` | `alineryd/src/main.rs`: PTY/RPC readers in `spawn_session` and `spawn_rpc_session` |
| `BeginRestate`, `ReserveRestate`, `PrepareReplacement` | `alineryd/src/main.rs`: `restate_session`, captured `replacing` flag and two durable mutations |
| `SpawnReplacement` | `restate_session` calls `spawn_session`; `alineryd/src/execution.rs::spawned` records Running |
| `CommitOldExit` | `alineryd/src/execution.rs::exited`; `alinery-core/src/execution.rs::confirm_execution_exit` |
| Capacity ownership | `ExecutionLifecycle::holds_capacity`, `claim_execution_launch`, and `recover_execution_owner` in core `execution.rs` |
| `ExitDelivery.Attempt` | `exited` calling `mutate_execution_state`; nonblocking repository lock in core `lockfile.rs::with_task_mutation_lock` |
| Stale completion boundary | `main.rs::handle_runner_event` authenticates; `accept_phase_completion` commits completion |

Each durable mutation is modeled atomically. The flag check outside a mutation
is a separate action: combining them would hide the bug. Process creation and
the successful Running commit are collapsed into one action; the omitted gap
retains capacity as Starting.

## Run

Use Java 11+ and the official [TLA+ tools](https://github.com/tlaplus/tlaplus)
release [v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
The runner checks the JAR's SHA-256 and requires both historical counterexamples
and both corrected-model passes. It creates model-checker state only in a
temporary directory.

```sh
curl -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o /tmp/alinery-tla2tools-1.7.4.jar
python3 docs/formal/playbooks/check.py /tmp/alinery-tla2tools-1.7.4.jar
```

If macOS's `java` is an unconfigured launcher, set `JAVA` to the installed binary,
for example `JAVA=/opt/homebrew/opt/openjdk/bin/java`. TLC's Java management socket
requires local socket permission in a sandbox.

Checked with TLC 2.19 (v1.7.4) and OpenJDK 26.0.2.1:

| Configuration | Result |
| --- | --- |
| `ExitOwnership.before` | Expected safety violation, 8-state trace |
| `ExitOwnership` | Pass: 20 distinct states, 25 generated |
| `ExitDelivery.before` | Expected liveness violation, terminating in stuttering |
| `ExitDelivery` | Pass: 5 distinct states, 7 generated |

Rust regression commands, from `alinery-app/src-tauri`:

```sh
cargo test -p alineryd --bin alineryd execution::tests -- --nocapture
cargo test -p alineryd --test playbook_v2_runtime \
  completed_owner_exit_survives_task_mutation_contention -- --nocapture
```

Both stale-callback tests failed before their guards and passed afterward.
The daemon test held a real repository flock while a fake harness exited:
before the fix, its accepted execution remained Finishing after 12 seconds;
after the fix, shutdown was recorded and the next coding execution launched.
All daemon tests use disposable fixtures; the desktop app is not launched.

Repository verification also passed:

```sh
# From alinery-app/src-tauri:
cargo check -p alinery-app
# From the repository root (Node 26):
NODE_OPTIONS=--no-experimental-webstorage ./scripts/check.sh
```

The full gate included 1,009 frontend tests, Rust workspace tests, formatting,
linting, source guards, and the behavioral shell suites. Required sidecars were
prepared with `bash alinery-app/src-tauri/scripts/copy-sidecar.sh debug` from the
repository root; missing frontend dependencies
were installed from the existing lockfile with `npm ci --no-audit --no-fund`.

## Verification boundary

- `ExitOwnership` models one unaccepted execution, two process generations, one
  successful replacement (or rejection before reservation), and one delayed old
  exit callback. It checks shutdown proof and retained capacity, not all restate
  failure paths or repeated replacement.
- `ExitDelivery` assumes one finite competing transaction, eventual lock release,
  and fair scheduling of retry attempts. It does not prove starvation freedom
  under perpetual contention, permanent I/O failure recovery, or crash recovery.
- Output contents, malicious harness behavior, fan-out/merge/loop semantics,
  configuration changes, backups, and filesystem crash durability are outside
  these models. These remain candidates for separate verification slices.
- The model and Rust correspondence is reviewed manually and backed by targeted
  regressions. Keeping a model alongside code does not automatically keep them
  equivalent after future changes.
