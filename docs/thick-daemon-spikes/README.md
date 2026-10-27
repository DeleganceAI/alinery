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
| `src/grpc-server.ts`, `src/grpc-adapter.ts` and its test | S0.2, O1 (b) | `@grpc/grpc-js` on a unix socket: Connect-shaped handlers through an adapter, bearer auth, `ErrorDetail` in `grpc-status-details-bin`, the peer check at accept with one server per peer class; the same handlers in memory under `createRouterTransport` |
| `src/rpc-server.ts`, `src/peer.ts` | S0.2, O1 (a) | Connect-ES on `node:http` or `node:http2` over a unix socket, bearer auth, the peer check through the `node:net` listener (`peer.ts` is shared) |
| `src/rpc-bench.ts`, `src/jsonl-server.ts`, `src/idle-streams.ts`, `src/h2-probe.ts` | S0.2 | Latency, throughput, cancel and memory against today's JSON-lines wire; `http2` mode is the gRPC transport over one HTTP/2 connection |
| `src/grpc-bridge.ts` and its test | S0.3, O2 (a) | The webview half under gRPC-web: `grpcWebFetch` (content types) over `bridgeFetch`, and a `node:http2` stand-in for the shell |
| `src/bridge-fetch.ts` and its test | S0.3 | Frames to a `fetch` Response, TRAILERS to a gRPC-web trailer frame; the test is the Connect (HTTP/1.1) version |
| `bridge-rs/src/bin/h2.rs` | S0.3, O2 (a) | The shell half: hyper 1 HTTP/2 client, one connection per daemon, one stream per call, against `grpc-server.ts` |
| `bridge-rs/src/main.rs` | S0.3 | The HTTP/1.1 shell half for Connect, one connection per call; its test checks frames match the TypeScript encoder |
| `src/watch.ts` | S0.4 | Bun `fs.watch` recursive against `@parcel/watcher` 2.6.0 |
| `src/lock.ts`, `src/lock.test.ts`, `lock-rs/` | S0.5, S2.2 | flock, errno and `F_FULLFSYNC` through `bun:ffi`, interop with `alinery-core`'s `lockfile.rs` |
| `src/fsync-bench.ts` | S0.5 | Cost of one 1 KiB durable replace per sync mode |
| `src/hardened-probe.ts` | S0.5 | The FFI checks in a binary signed with the hardened runtime |
| `src/scan-bench.ts` | O3, S2.3 | Full index scan and the async 30 s reconcile on copies of a real `.alinery` |
| `src/sqlite-bench.ts` | O3 (b), not adopted | `bun:sqlite` as the truth: commit cost per sync mode, import, start-up load, snapshot and export against the file scan |
| `src/store.ts`, `src/store.test.ts` | S2.1 | The sync store: commit, ring, Subscribe frames, the property test |
| `src/toml-roundtrip.ts` | S4.1, S4.3 | Whether `Bun.TOML.stringify` and smol-toml write the bytes Rust's `toml::to_string` does |

## Rerun

### S0.1 toolchain

```bash
cp -r gen $T/gen-before && bun run gen && diff -r $T/gen-before gen   # no diff; buf lint prints nothing
bunx tsc --noEmit -p .
OUT=$T/vite-out ../../alinery-app/node_modules/.bin/vite build --config vite.config.mjs
```

Needs `npm ci` in `alinery-app` for Vite. Result: with the gRPC-web transport (`ui-client.ts` today) the bundle is 175,426 bytes, 41,581 gzipped; with the Connect transport it was 176,382 and 41,886 (Vite 7.3.6).

### S0.2 RPC

O1 (b), grpc-js, the decided host:

```bash
bun src/grpc-server.ts $D/g.sock & SP=$!
bun src/jsonl-server.ts $D/j.sock & JP=$!
sleep 1.5
bun src/rpc-bench.ts $D/g.sock $D/j.sock http2 $SP
bun src/idle-streams.ts $D/g.sock $SP 100 http2
bun src/idle-streams.ts $D/g.sock $SP 1000 http2
bun src/h2-probe.ts $D/g.sock   # prints "h2 grpc OK shell"
bun test src/grpc-adapter.test.ts   # 2 pass: in memory, and a stream error over grpc-js
node_modules/.bin/buf curl --protocol grpc --http2-prior-knowledge --unix-socket $D/g.sock --schema proto \
  -H 'authorization: Bearer spike-secret-0123456789abcdef' -d '{}' http://daemon/alinery.v1.AdminService/Hello
kill $SP $JP
```

`grpc-server.ts` takes the shell executable as a second argument (default: this Bun). A compiled probe is "other": `bun build --compile src/h2-probe.ts --outfile $T/h2-probe && $T/h2-probe $D/g.sock` prints `h2 grpc OK other`. Without the `-H` line `buf curl` prints `unauthenticated` and exits 128. For the compiled server, `bun build --compile src/grpc-server.ts --outfile $T/grpc-server` (72 MB).

Results: unary 100-byte echo p50 0.076 to 0.084 ms, p99 0.20 to 0.26 ms (JSON lines: p50 0.035 ms); 27,300 to 30,000 calls/s at 16 in flight; a stream of 16 KiB frames at 705 to 729 MB/s; cancel reaches the server and no stream is left after it; idle RSS 47 to 48 MB; an idle stream 41 to 51 KB at 100 open, 24 to 27 KB at 1,000.

Linux: in `debian:12` with the Linux Bun (as for S0.4 below), `--platform linux/arm64` and `linux/amd64`, `bun test src/grpc-adapter.test.ts src/grpc-bridge.test.ts` gives 8 pass on both, and `h2-probe.ts` connects. Under amd64 (Rosetta) the probe reports `other`, because the peer's `/proc/<pid>/exe` reads `/run/rosetta/rosetta`; native arm64 reports `shell`.

O1 (a), Connect on `node:http`, for comparison:

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

O2 (a) under gRPC-web, the decided bridge:

```bash
bun test src/grpc-bridge.test.ts   # 6 pass; prints the stand-in's unary p50 and p99
bun src/grpc-server.ts $D/g.sock & SP=$!; sleep 1.5
(cd bridge-rs && CARGO_TARGET_DIR=$T/bridge cargo run --release --locked --bin h2 -- $D/g.sock)
kill $SP
```

`h2` prints `bad token: grpc-status 16 in head: true, trailers frame: false`, the unary latency on one shared connection, calls/s at 16 in flight, and a 2 s stream with `cancel reached server: true; same connection still serves calls: true`. Results: through the Bun stand-in, unary p50 0.078 to 0.081 ms, p99 0.27 to 0.41 ms; through hyper's HTTP/2 client, p50 0.042 to 0.049 ms, p99 0.065 to 0.092 ms, about 59,500 calls/s at 16 in flight, 793 to 799 MB/s framed, 183,266 frames in 2 s unbatched.

The Connect (HTTP/1.1) version, for comparison:

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

### O3 SQLite (not adopted)

```bash
bun src/sqlite-bench.ts commit $D/sqlite 1000
SQLITE_LIB=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib bun src/sqlite-bench.ts commit $D/sqlite 1000
bun src/sqlite-bench.ts import <a real repo>/.alinery $T/sqlite 1 25 100
```

Bun on macOS loads `/usr/lib/libsqlite3.dylib` (3.54.0); `SQLITE_LIB` swaps in another one. Bun on Linux embeds 3.53.4. Commit p50 (row plus changelog row, WAL): `NORMAL` 0.012 to 0.017 ms; `FULL` 0.037 to 0.055 ms (Linux arm64 in Docker 0.505 ms); `FULL` with `fullfsync=1` 0.18 to 0.73 ms on the system library and 4.2 ms on Homebrew's, against about 9.8 ms for one `F_FULLFSYNC` file replace. Start-up load against the file scan: 43 tasks 1.0 against 7.0 ms, 1,075 tasks 11 against 173 ms, 4,300 tasks 43 against 777 ms; the database is 0.5, 11.8 and 46.9 MB.

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
