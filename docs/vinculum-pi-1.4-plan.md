# Upgrade Pi from 1.3.0 to 1.4.0

Status: implemented on `experimental-pi-durable-as-a-harness`. The daemon tests, the copy-instructions assertion, and a compiled debug sidecar passed. A live session has not been opened with it, so no `*.pi.sqlite` here has been migrated yet. This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

Move the three packages this daemon embeds from 1.3.0 to 1.4.0 together. Do not take a newer tag than 1.4.0, and do not leave them on different versions. npm published all three on 2026-10-21 and nothing after that.

| Package | Now | Target |
|---|---|---|
| `@earendil-works/pi-ai` | 1.3.0 (2026-10-15) | 1.4.0 |
| `@earendil-works/pi-durable` | 1.3.0 | 1.4.0 |
| `@earendil-works/chord` | 1.3.0 | 1.4.0 |

They live in one place: `alinery-app/src-tauri/vinculum-daemon/package.json` and that directory's `bun.lock`. The app runs the compiled sidecar, not these sources. Protocol stays 23. A rebuilt app will keep talking to the old daemon until that process is stopped.

## Do not expand the upgrade

- Do not add `@earendil-works/pi-coding-agent`. Vinculum already owns the loop through pi-durable.
- Do not set `HarnessOptions.identity`, telemetry, or `restartLimit`. 1.4.0's defaults are enough.
- Do not remove the local Azure rows in `runtime.ts` (`deepseek-v4-flash`, `grok-4.7`). 1.4.0's changelog does not add them. The installer already skips an id Pi ships, so leave that guard.
- Do not rewrite `docs/vinculum-providers-plan.md` or `docs/vinculum-customizations-plan.md`. Those describe what 1.3.0 was. The shipped copy-instructions string is the line that has to change.
- Do not bump `PROTOCOL_VERSION`. No socket op changes.

## Session files move forward only

Opening a `*.pi.sqlite` with pi-durable 1.4.0 migrates it to SQLite schema 2 and rebuilds the task table. A 1.3.0 daemon cannot open that file again. There is no down migration. JSONL storage is not what this daemon uses.

That is the rollback. After the new daemon has opened a session, going back to 1.3.0 means that session file is unreadable. Do this on `experimental-pi-durable-as-a-harness` only. Do not point a 1.3.0 daemon at a repo whose sessions the 1.4.0 daemon has already opened.

`openNodeSqliteStorage` in `main.ts` and in `sessionControls.test.ts` needs no new argument. The migration happens inside `open`.

## What will fail to compile

`defineDoc()` now requires `checkpointWhen`. There is no default. The two docs this process defines are `Attention` and `PhaseRequest` in `vinculum-daemon/src/main.ts`. Pass `checkpointWhen: () => false` on both so they stay deltas. Do not invent a checkpoint schedule. `AgentDoc` and `LiveDoc` are Pi's.

The copy-instructions text in `alinery-app/src-tauri/src/vinculum_customizations.rs` says `pi-durable 1.3.0`. The test in `src/tests/vinculum_customizations.rs` asserts that string. Change both to 1.4.0. That is the only product sentence that names the version.

This repo does not call `telemetryContext`, `getPiUserAgent`, or `resolveTranscriptTools()`. Those pi-ai renames should not touch our files. If a type error names one, fix that call. Do not adopt the new telemetry API.

## What to re-check after install, not before

`provider.ts` comments that pi-ai 1.3.0 ignores a top-level `stream` and wants `api.stream`. Re-read `createProvider` in 1.4.0. Keep the shape that still typechecks. Update the comment if the reason changed. Do not restructure the Alinery provider.

`installAzureFoundryModels` replaces `getModels` / `getAllModels` on the Azure provider. Run `azureModels.test.ts`. If 1.4.0 already lists either id, the existing filter must leave a single row, still on `openai-completions`, still with an empty `baseUrl`.

`api.models` inside a tool is now a wrapper, not the host's `Models` object. Our tools close over the daemon's own `models`. Leave them. Touch one only if the typecheck says the wrapper is required.

A task that crashes five times without committing is parked. Do not set `restartLimit` to `Infinity` up front. If a session comes back blocked with `restart_limit` during the smoke, that is a 1.4.0 behavior change to report, not a setting to disable in the same commit.

`ToolControl.terminate` is now `boolean`. A `true` we already return still ends the run.

## Steps

1. In `vinculum-daemon`, set the three versions to `1.4.0` and run `bun install` there so `bun.lock` moves. Do not hand-edit the lock.
2. Add `checkpointWhen: () => false` to both `defineDoc` calls.
3. Change the copy-instructions version and its Rust assertion.
4. `bun test` in `vinculum-daemon`. Fix only what 1.4.0 broke.
5. `bun build src/main.ts --target bun` to see the TypeScript bundle. Then compile the sidecar the app actually runs (`scripts/dev-fetch-bun.sh`, or the compile `npm run tauri dev` does). A plain `bun build --target bun` does not catch the missing OAuth and Bedrock modules that only the compiled binary loads. `runtime.ts` still registers those static copies. Do not leave a probe file in the daemon directory.
6. `cargo check -p alinery-app` after the Rust string change. `cargo test -p alinery-app -- vinculum_customizations` for the copy-instructions assertion.

## Smoke, after the daemon is replaced

Stop the running daemon first. Protocol 23 will reuse it.

- An existing session file opens, and a new message still runs. That file is now schema 2.
- Azure still lists `deepseek-v4-pro`, `deepseek-v4-flash`, and `grok-4.7`. A locked step still shows **Finish step**.
- Bedrock and an OAuth provider still sign in. Those paths are why the compiled binary matters.
- A new session still takes the Settings thinking default, and the transcript still returns thinking and tool parts.

Do not run `./scripts/check.sh` unless asked. Do not launch the desktop app unless asked.
