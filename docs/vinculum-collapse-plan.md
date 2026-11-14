# Vinculum collapse plan

Status: in progress. `alinery-core` stays, including task provisioning. `alinery-vinculum-daemon` replaces the `alineryd` process and the OMP harness binary.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

## Goal

One process, `alinery-vinculum-daemon`, loads a task, ticks the TypeScript playbook engine, and runs Pi sessions itself. A `no-harness` shell is the terminal, in the same process. A remote machine needs the repo, model credentials, that binary, and `libalinery_core` beside it. It does not need the Tauri app, `alinery-playbook`, `alineryd`, or the OMP binary.

The UI socket stays newline-JSON on `.alinery/alineryd.sock`. A terminal attach takes over that same connection as a byte stream after one `{"ok":true}` line. Do not add a second protocol or a second listener. Do not retarget this work at `main`.

Published names are Vinculum, unless the code requires the pi name or an internal note that the agent runtime is pi-durable. The stored harness key `omp` can remain; the UI already shows it as Vinculum.

## What stays in alinery-core

`provision_task` and `create_subtask` stay the one provisioning implementation. Vinculum calls them through a JSON FFI on `libalinery_core`, the library it already loads for the lane lock. It does not call `alineryd::execution::create_task`, because that also runs the Rust playbook reconciler. On `creation = "ready"` and start requested, Vinculum ticks the TypeScript engine.

The lane lock stays in that library. The bundle copies `libalinery_core` next to the app. For `--repo` with no app, the daemon finds the library beside its own executable when `ALINERY_OWNERSHIP_LIB` is unset.

Provisioning does not start shells and does not start OMP.

## Sessions

One daemon process holds every session. `models` and `registry` are created once. Each session gets its own in-process harness and `*.pi.sqlite`. Startup resumes every sqlite whose meta has started and not ended. A bash tool run is a short-lived child process. There is no pi-durable process per session.

## What is removed with OMP

OMP's PTY and RPC transports, `rpc_attach`, `rpc_write`, `restate`, `omp_setup`, the OMP host guard, `alinery-runner`, the `event` op, and the session UI that only drives an OMP process. Removing those ops bumps `PROTOCOL_VERSION`. The terminal ops stay.

## Terminal

The Terminal drawer and `no-harness` sessions use `Bun.Terminal` inside Vinculum. `attach` never spawns. Reattach sends the scrollback tail. There is no second `vt100` emulator. Pi sessions stay in-process; `write` and `resize` stay unsupported for them.

## Keep-awake

The idle-sleep hold moves with the daemon. A live Pi session or a live terminal counts.

## Order

1. Call `alinery-core` provisioning from Vinculum. Delete the thin TypeScript create and any direct `git` spawn.
2. Delete the playbook helper, its socket, `pi_open`, and `ALINERY_PI_LAUNCH_TOKEN`.
3. Implement the `no-harness` terminal in Vinculum.
4. Remove the OMP binary path and bump the protocol.
5. Make Vinculum the sidecar, move keep-awake, point MCP at it, and delete the `alineryd` crate.
6. Prove it: academic-survey through a fan-out and a fan-in, and a `no-harness` terminal, with no Tauri process, no helper, no `alineryd`, and no `omp` process.

## Limits

No replay of old Rust execution files. No parity run against the Rust scheduler. No playbook library editor. A PTY that `alineryd` already started is not adopted.
