# Thick-daemon spikes

Throwaway code from the plan review of `docs/thick-daemon-plan.md` (2026-10-27). It is evidence for the plan's 4.1 results and a pattern sessions copy from. It is not product code, and nothing in the app imports it.

All numbers below are Bun 1.4.3 on an M4 Max (macOS arm64, FileVault on) unless a line says otherwise. A rerun on Apple silicon should land within 2x.

## Setup

```bash
cd docs/thick-daemon-spikes
bun install --frozen-lockfile
bun run gen        # optional: regenerates gen/ and runs buf lint (S0.1 below checks it reproduces)
```

`T` below is a scratch directory outside the repo (cargo targets, compiled binaries). `D` is a scratch directory for sockets.

## Files

| File | Plan slot | What it shows |
|---|---|---|
| `proto/`, `gen/`, `buf.yaml`, `buf.gen.yaml` | S0.1 | protoc-gen-es 2.16.0 `target=ts`, no import extension; buf 1.75.0 from `node_modules/.bin` |
| `src/ui-client.ts`, `vite.config.mjs` | S0.1, S0.3 | The generated code and a connect-web client built by the app's Vite |
| `src/rpc-server.ts`, `src/peer.ts` | S0.2 | Connect-ES on `node:http` or `node:http2` over a unix socket, bearer auth, the peer check through the `node:net` listener |
| `src/rpc-bench.ts`, `src/jsonl-server.ts`, `src/idle-streams.ts`, `src/h2-probe.ts` | S0.2 | Latency, throughput, cancel and memory against today's JSON-lines wire; gRPC over `node:http2` |
| `src/bridge-fetch.ts` and its test | S0.3 | The webview half of the bridge: frames to a `fetch` Response under a stock connect-web client |
| `bridge-rs/` | S0.3 | The shell half: hyper 1 over the unix socket, one connection per call, frames identical to the TypeScript encoder |
| `src/watch.ts` | S0.4 | Bun `fs.watch` recursive against `@parcel/watcher` 2.6.0 |
| `src/lock.ts`, `src/lock.test.ts`, `lock-rs/` | S0.5, S2.2 | flock, errno and `F_FULLFSYNC` through `bun:ffi`, interop with `alinery-core`'s `lockfile.rs` |
| `src/fsync-bench.ts` | S0.5 | Cost of one 1 KiB durable replace per sync mode |
| `src/hardened-probe.ts` | S0.5 | The FFI checks in a binary signed with the hardened runtime |
| `src/scan-bench.ts` | O3, S2.3 | Full index scan and the async 30 s reconcile on copies of a real `.alinery` |
| `src/store.ts`, `src/store.test.ts` | S2.1 | The sync store: commit, ring, Subscribe frames, the property test |
| `src/toml-roundtrip.ts` | S4.1, S4.3 | Whether `Bun.TOML.stringify` and smol-toml write the bytes Rust's `toml::to_string` does |

## Rerun

### S0.1 toolchain

```bash
cp -r gen $T/gen-before && bun run gen && diff -r $T/gen-before gen   # no diff; buf lint prints nothing
bunx tsc --noEmit -p .
OUT=$T/vite-out ../../alinery-app/node_modules/.bin/vite build --config vite.config.mjs
```

Needs `npm ci` in `alinery-app` for Vite. Result: the bundle is 176,382 bytes, 41,886 gzipped (Vite 7.3.6).

### S0.2 RPC

```bash
bun src/rpc-server.ts $D/rpc.sock http1 & SP=$!
bun src/jsonl-server.ts $D/j.sock & JP=$!
sleep 1.5
bun src/rpc-bench.ts $D/rpc.sock $D/j.sock http1 $SP
bun src/idle-streams.ts $D/rpc.sock $SP 100
bun src/idle-streams.ts $D/rpc.sock $SP 1000
kill $SP $JP

bun src/rpc-server.ts $D/h2.sock http2 & SP=$!; sleep 1.5
bun src/h2-probe.ts $D/h2.sock   # prints "h2 grpc OK"
kill $SP
```

For the compiled server, `bun build --compile src/rpc-server.ts --outfile $T/rpc-server` and start `$T/rpc-server $D/rpc.sock http1` in place of the first line.

Results: unary 100-byte echo p50 0.078 to 0.081 ms, p99 0.27 to 0.35 ms (JSON lines: p50 0.035 ms); about 34,500 calls/s at 16 in flight; a stream of 16 KiB frames at 356 to 362 MB/s; idle RSS about 47 MB; an idle stream about 143 KB each at 100 open, 55 KB at 1,000.

### S0.3 bridge

```bash
bun test src/bridge-fetch.test.ts
(cd bridge-rs && CARGO_TARGET_DIR=$T/bridge cargo test --locked)
```

Six pass, and `frame_matches_typescript` passes. A stack trace from the server after the cancel test is the expected broken pipe (EPIPE), not a failure. Results: through the Bun stand-in for the shell, unary p50 0.095 ms, p99 0.45 ms; hyper over the socket, p50 0.076 ms.

### S0.4 watcher

```bash
bun run src/watch.ts matrix --reps 2 --idle-seconds 30
bun build src/watch.ts --compile --outfile $T/watch && $T/watch matrix --reps 2 --idle-seconds 30
```

A few minutes each. One JSON line per run. Results (both runners agree):

| | Bun `fs.watch` recursive | `@parcel/watcher` |
|---|---|---|
| Paced: ops with no event / extra events, per 3,000 | 0 / 1 to 5 | 0 / 0 |
| Paced: latency p50 / p95 | 31 / 54 ms | about 260 / 480 ms |
| Paced: CPU | 0.8 to 0.9% | 2.7 to 4.4% |
| Burst: paths whose last op got no event | 0 | 0 (1 in one run with the ignore list) |
| Idle, 200 tasks: CPU / RSS | 0.1% / 7.4 MB | 0.1% / 7.6 to 7.9 MB |

`--flat` runs (Bun #44780's trigger) showed no misses for either; one compiled Bun run reported events for `.alinery/tasks/tasks`, which does not exist. `reg` (Bun #34160): 500 non-recursive watches 345 to 810 ms, 1,500 about 4.7 s, 3,000 about 22.8 s.

Linux was not run (S2.3's Accept). The shape that worked for the lock test: a `debian:12` container with this folder mounted and the official `bun-v1.4.3` Linux build (checked against its `SHASUMS256.txt`), `--platform linux/arm64` or `linux/amd64`. Inside it run `bun install --frozen-lockfile` into a copy of this folder first, so the Linux `@parcel/watcher` addon is installed, then the two commands above. `watch.ts` names the darwin-arm64, linux-arm64-glibc and linux-x64-glibc addons; `--compile` keeps only the target's branch.

### S0.5 locks, errno, durability

```bash
(cd lock-rs && CARGO_TARGET_DIR=$T/lock cargo build --release --locked)
LOCK_RS_BIN=$T/lock/release/lock-rs bun test --rerun-each 10 src/lock.test.ts   # 60 pass
bun src/fsync-bench.ts $D/fsync 1000
$T/lock/release/lock-rs durable $D/fsync-rs 1000
```

Results: 60 of 60 on macOS arm64, Linux arm64 and Linux x64 (emulated). A 1 KiB durable replace: `F_FULLFSYNC` through `bun:ffi` p50 9.8 to 10.2 ms, Rust `write_bytes_durable` 9.8 to 10.2 ms, plain `fsync` 0.12 ms, no sync 0.11 ms.

Linux: build `lock-rs` with `cargo zigbuild --release --locked --target aarch64-unknown-linux-gnu` (or `x86_64-unknown-linux-gnu`), then run the same `bun test` with the Linux Bun inside `debian:12` as for S0.4, with `LOCK_RS_BIN` pointing at the Linux build.

**Hardened runtime (for the user, needs the release identity):**

```bash
bun build --compile src/hardened-probe.ts --outfile $T/hardened-probe
codesign --force --timestamp --options runtime --entitlements <release daemon entitlements.plist> \
  --sign "Developer ID Application: <team>" $T/hardened-probe
codesign -dv --entitlements - $T/hardened-probe   # expect flags=0x10000(runtime)
$T/hardened-probe                                  # expect exit 0 and "ok":true
```

The review ran it with Bun's ad-hoc signature only.

### O3 scan and reconcile

```bash
bun src/scan-bench.ts <a real repo>/.alinery $T/scan 1 25 100
```

The copy counts after the scratch directory multiply the real tasks. With this repo's 43 tasks: full scan 7.2 ms; at 1,075 tasks 165 ms, a 4.5 MB index, reconcile 42 ms with a 3.3 ms longest loop gap; at 4,300 tasks 745 ms, 24 MB, 167 ms, 5.4 ms.

### S2.1 store

```bash
bun test src/store.test.ts
```

The property test runs 20 seeds of 400 commits with drops, resumes, queue overflow and ring rollover. The fan-out test prints one commit at 0.8 µs with 1 subscriber, 2.4 µs with 10, 9.1 µs with 100, and a 93-byte one-task delta.

### S4.1 TOML

```bash
bun src/toml-roundtrip.ts <repo>/.alinery/config.toml <repo>/.alinery/tasks/*/task.md
```

Result on this repo: `Bun.TOML.stringify` byte-identical for 43 of 43 `task.md` files; smol-toml for 5 of 44 files.

### S7.2 `bun:jsc`

```bash
echo 'import { heapStats } from "bun:jsc"; console.log(Bun.version, heapStats().heapSize)' > $T/jsc.ts
bun $T/jsc.ts && bun build --compile $T/jsc.ts --outfile $T/jsc && $T/jsc
```

Both print a heap size.
