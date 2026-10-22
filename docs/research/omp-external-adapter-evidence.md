# Frozen external-adapter research evidence

## Purpose and status

This inventory preserves 29 opt-in diagnostic scripts from task `simplify-playbook-completion-and-continuation`: 28 previously untracked scripts and the expanded owner-job diagnostic. Their **bytes and existing paths are unchanged** by archival. They are research evidence, not 29 production regression tests or a completed external adapter.

The practical recommendation is to build Alinery's review/continuation UX and durable lifecycle with a modest replaceable OMP integration, without advertising a universal guarantee that every autonomous OMP effect is fenced at acceptance. The experiments support substantial bounded capabilities and identify unresolved boundaries; they do not prove either complete feasibility or global impossibility. No implementation scope or safety requirement changes merely because evidence is archived.

The original investigation reports, failures, commands, source ranges and hashes remain in the task's retained artifact store:

```text
<target-repo>/.alinery/tasks/simplify-playbook-completion-and-continuation/artifacts/
```

Those task artifacts are local Alinery data, **not files included in this Git commit**. Principal entry points are `external-adapter-practical-recommendation.md`, `external-adapter-and-future-harness-lessons.md`, `runtime-ownership-integration-contracts-auxiliary.md`, and `external-adapter-coverage-and-cost-matrix.md`. The classifications and limitations below preserve the essential interpretation in the source repository even when that task store is unavailable. Do not claim a fresh runtime pass from this inventory.

## Integrity and check integration

- Manifest: [omp-external-adapter-evidence.sha256](omp-external-adapter-evidence.sha256). Paths are relative to repository root.
- Binary used by the investigations: `/Applications/Alinery.omp/omp`, **v18.1.13**, SHA-256 `9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47`.
- Native source inspected: commit `a1b254047d12e143b7c6011536e918c6c35c5906` in the OMP source repository, via exact-commit extraction rather than checkout HEAD.
- Hash-guarded drivers read sibling files and use exact source-text anchors. One driver also uses a repository-root-relative fixture path. Keeping all paths and bytes intact preserves those dependencies and historical report identities.
- `alinery-app/biome.jsonc` explicitly excludes **only these 29 frozen filenames**. This is intentional archival treatment, not a relaxation for production files, maintained tests or future diagnostics. No wildcard exemption was added, no rules were disabled globally, and no script was registered in normal test commands.
- The separate `external_composition_smoke.mjs`, provider-service and manual-completion diagnostics were added by this PR. They are unfrozen, outside the 29-file manifest and its formatter exclusions, and may change as the supported runtime contracts evolve. Their standalone commands are not covered by the frozen-evidence integrity check.
- Never run bulk format/fix over this evidence, rewrite expected hashes to conceal drift, or turn expected coverage-gap exits into success. Extend a reviewed new copy for future work; preserve the historical bytes and report the new identity.

Verify the frozen set without launching OMP:

```sh
# From repository root; supported by macOS shasum.
shasum -a 256 -c docs/research/omp-external-adapter-evidence.sha256

# Inspect an individual script's syntax without executing its experiment:
node --check alinery-app/src-tauri/runner/tests/external_wave_nested_eval_identity.mjs
```

These checks verify identity/syntax, not runtime safety. The research scripts are not automatically executed by `scripts/check.sh`. Their historical lint/style issues are preserved because changing them would invalidate hash/anchor evidence; production and maintained-test lint still runs normally.

## Reading results correctly

- **Bounded**: actual reported assertions passed for a named subset. Not an integrated safety certificate.
- **Counterexample**: an intentionally observed failure of a proposed safety/lifetime rule. Exit 0 may mean the counterexample was reproduced successfully.
- **Coverage gap**: often intentional exit 3, even with useful bounded positives. Never treat it as a product pass.
- **Superseded candidate**: preserve its evidence, but do not adopt its mechanism without accounting for later findings.
- **Unsupported attachment**: an experiment found that a proposed interception mechanism did not reach the actual work. This does not prove all external alternatives impossible.

Synthetic Promise failures, deliberate extension writers and public-method fault injections must remain labelled as such. They are not spontaneous native logger failures or built-in late writers. Timeouts, cancellation, process exit, absent traffic and empty local ledgers are not general settlement certificates.

## Classified inventory

All filenames below live in `alinery-app/src-tauri/runner/tests/`. Report names refer to the retained task artifact directory above.

| Frozen script | Classification and result to preserve | Use for the practical adapter / limitation |
|---|---|---|
| `external_autolearn_descendants_smoke.mjs` | Unsupported attachment research: packaged async-hooks capability and early subscription scope candidate. | Preserve failed lifecycle-observation approach; do not rerun without a materially different attachment. Controller reports and integration ledger contain the history. |
| `external_autolearn_smoke.mjs` | Bounded native automatic capture plus counterexamples: first-method-return fence can discard pending replay; public drain composition misses capture work. | Original controller/managed-skill fixture and later memory probe dependency. Method return or idle is not controller exhaustion. See owner-job/delivery report. |
| `external_cancel_admission_ack_smoke.mjs` | Bounded never-forwarded withdrawal in both languages. | Sole external forwarder can irrevocably withdraw HELD work. Does not reconcile work already forwarded. See cancellation-admission-ACK report. |
| `external_controller_lifecycle_smoke.mjs` | Bounded cancellation/newSession with held native refresh; uses older Promise-chain observer. | Useful native lifecycle oracles; observer's final-leaf rejection handling is superseded. See controller lifecycle transitions report. |
| `external_controller_ownership_smoke.mjs` | Bounded original catch/finally-chain replay; superseded rejection-observation candidate. | Fixture for real pending capture transfer. Extra rejection observers alter error observability; do not promote unchanged wrapper to production. |
| `external_eval_bridge_smoke.mjs` | Early stock JS/Python attachment and known-ID settlement investigation with per-path reachability limits. | Retain actual supported/unsupported outcomes; later IPC and lifecycle reports refine coverage. Not universal all-language ownership. |
| `external_forwarded_ack_recovery_smoke.mjs` | Bounded Python Response capture before delivery; abort-race counterexample remains. | Successful result loss can retain actual ID/wait; abort-during-creation can hide the ID while producer is pending. Unknown stays blocked. |
| `external_hidden_outcome_fatal_interceptor.mjs` | Bounded non-consuming public hook before actual native fatal persistence. | Pre-effect observation, not durable admission or cleanup settlement. Synthetic trigger, actual JSONL write and preserved native fatal exit. |
| `external_js_ipc_bridge_smoke.mjs` | Bounded stock subprocess IPC interception and known-ID producer ownership. | Original native transport/ToolSession evidence; does not repair suppressed replies after worker death. |
| `external_js_lifecycle_smoke.mjs` | Bounded owner removal/concurrency/reused-worker attribution; unknown ACK and transport-tail counterexamples. | Actual host dispatch/run identity, not persistent-worker ancestry. Particular rejected-fetch tail later classified private unwind, not late semantic writer. |
| `external_maintenance_lifecycle_smoke.mjs` | Bounded actual incomplete recovery removal/restoration with real receiver binding. | Own outer check before earlier active-context mutation. Original case proves no-rewrite restoration, not full rescue/fallback coverage. |
| `external_maintenance_ownership_smoke.mjs` | Bounded speculative promise, native file write, cancellation/slot removal, armed commit and explicit caller-owned queue path. | Shared original fixture for later probes. Slot disappearance is not settlement; explicit caller scope is not automatic installation. |
| `external_owner_jobs_smoke.mjs` | Bounded native jobs/delivery/spill/owner isolation; cancellation and explicitly registered late-callback counterexamples. | Native receipts and useful peer work preserved. Watched/suppressed delivery is not ceased work; callback writer is extension work, not a hidden built-in writer. |
| `external_ownership_continuation_controller.mjs` | New narrower original synchronous scheduling-finally scope; bounded replay/cancel/newSession plus preserved synthetic unhandled errors and real fatal-persistence counterexample. | Avoids observing final rejected leaf. Fatal transcript append/flush can occur after callback scope releases; no universal closure. |
| `external_py_lifecycle_smoke.mjs` | Bounded native Python owner removal/concurrency/cancellation with retained unknown outcomes. | Real backend/kernel/run mapping and prebound native waits; no unknown release on cancellation or disposal. Later nested-eval probe strengthens overlapping same-owner attribution. |
| `external_wave_callback_timeouts_probe.mjs` | Bounded original registered extension handler ownership beyond real native timeout/abort; synchronous returns/errors preserved. | Late write belongs to deliberately registered extension, not built-in writer. Async rejection transparency and all-factory coverage unproved. |
| `external_wave_controller_errors_provider.mjs` | Negative rejection-oracle result: real HTTP 400 fulfills native capture; useful pending replay remains owned. | Preserve distinction between provider error and rejected workflow Promise. Genuine escaping native capture rejection remains unestablished. |
| `external_wave_controller_transitions_probe.mjs` | Six bounded switch/reload/branch/cancel/rollback cases with retained pending capture/refresh. | Good lifecycle regression inputs; local IDs/call counts are not authoritative generations. Initial generated-fixture syntax failure remains reported. |
| `external_wave_fatal_lifetime_ordering.mjs` | Preadmitted-hold positive and locally sealed admission counterexample. | Non-consuming hook cannot prevent native persistence; no safe encompassing lifetime/release established. Not a real daemon acceptance race. |
| `external_wave_fatal_owner_routes_probe.mjs` | Two real managers; six native routes show rejection-hook coverage and bypasses. | Known closed owner cohort is not automatic attribution. Exception/direct fatal/signal/dispose bypass hook; reason text is not route evidence. |
| `external_wave_ingress_coverage_nonchat.mjs` | Bounded original bash/Python pre-effect gating/native errors; genuine automatic idle-steer queue retention. | Directly useful for selected ingress. Explicit caller-owned queue scope is not universal automatic ownership, PTY coverage or durable authority. |
| `external_wave_maintenance_manual_lifetimes.mjs` | Original compact/handoff body ownership; real cancellation before auth completion and after saved-document write boundary. | Cancellation can still permit later native write/commit. Saved case uses explicit autoTriggered option; default manual handoff does not save that file. File comparison is trim-based. |
| `external_wave_maintenance_pruning_smoke.mjs` | Native stale-read/thinking/image/elide positives; real newSession crossing elide await counterexample. | Admission must precede in-memory mutation. Not proof of new-conversation corruption. Initial recent-tail-protected fixture failed and was corrected with genuine history. |
| `external_wave_maintenance_rescue_probe.mjs` | Actual rescue rewrite and real EISDIR after mutation. | Native recovery restores failed assistant, not full history; user elision can remain. Later persistence must be separately accounted for. |
| `external_wave_maintenance_transfer_smoke.mjs` | Automatic actual-receiver reservation plus out-of-band native idle join retains one useful queued continuation. | Concrete composable candidate without broad caller lease; not all deferred/coalesced/error/generation paths. No scheduler-child self-wait. |
| `external_wave_memory_advisor_work_local.mjs` | Real local-memory learn in two automatic captures. | Distinct from managed-skill writes. Does not establish memory startup, extraction/embedding, remote retention or advisor-wide ownership. |
| `external_wave_nested_eval_identity.mjs` | Overlapping same-owner Python calls and reused native kernel correctly attributed; FIFO assumption counterexample. | Actual arrival/run identity, not submission labels. Does not solve nested finalization/ancestor self-wait. Failed arrival-order oracle remains reported. |
| `external_wave_recovery_retry_tail_probe.mjs` | Actual normal retry/backoff abort/void-descendant paths show saga settlement before later work/events. | Later persistence invocation is idempotent, not observed late append. Public empty-context fault input is explicit. Three failed HTTP-trigger attempts retained. |
| `external_wave_startup_owner_binding_probe.mjs` | Actual getter/ref binding before SDK return, concurrent construction and same-name replacement with old maintenance held. | Attachment is after some startup effects; zero capture invocations. Local ready=false sentinel is not stale-click proof; unmapped forwarding is not production fail-closed behavior. |

For the fourteen `external_wave_*` scripts, corresponding report filenames are `external-wave-<slice>-investigation.md`, with keys: `callback-timeouts`, `controller-errors`, `controller-transitions`, `fatal-lifetime`, `fatal-owner-routes`, `ingress-coverage`, `maintenance-manual`, `maintenance-pruning`, `maintenance-rescue`, `maintenance-transfer`, `memory-advisor-work`, `nested-eval`, `recovery-retry-tail`, `startup-owner-binding`.

The five wave reports with no new diagnostic are `js-hidden-outcome`, `python-hidden-outcome`, `provider-relevant-tails`, `jobs-revival`, and `stock-installation`. They are source-only assessments, not missing test results.

## Running a selected historical experiment

Read its script and report first; many drivers require a positional mode rather than accepting `--help`. Use only the exact runtime, isolated configuration and loopback fixtures described by the report. Never use real credentials, real services or real project shutdown to reproduce these probes. Only fixture-owned processes may be disposed. Some scripts intentionally cause their own native process to exit fatally.

Examples from repository root:

```sh
node alinery-app/src-tauri/runner/tests/external_ownership_continuation_controller.mjs normal
node alinery-app/src-tauri/runner/tests/external_controller_lifecycle_smoke.mjs new-session
node alinery-app/src-tauri/runner/tests/external_wave_fatal_lifetime_ordering.mjs sealed
```

These are opt-in research commands with intentionally incomplete outcomes, not the commands to declare a product release green. Do not indiscriminately execute the collection in parallel or change retries/features to make it pass.

## What to promote into maintained regression tests

Start with observable behavior the practical adapter actually ships: ready vs accepted, real review invalidation, controlled ingress versus Continue in both orders, exact undelivered-input preservation, immutable receipt replay, authoritative exit-and-drain confirmation, and selected native boundaries genuinely installed in the stock CLI.

The unfrozen `external_composition_smoke.mjs`, added by this PR, contains useful native delegation/queued-review/stale-intent/input-retention oracles. The committed daemon/extension bookkeeping regressions cover their separate reliability fix. New production tests should exercise the real implementation and reject plausible regressions, not import a historical local Set as durable authority.

Only extract the smallest relevant deterministic cases. Do not promote every private workflow, failed-candidate implementation or provider experiment into permanent CI. Keep limitations explicit, retain counterexamples for future harness work, and avoid broad exception rules that silently remove useful admitted work.

## Archive verification versus repository readiness

The archive preparation checks all 29 SHA-256 values and JavaScript syntax without editing or executing the historical experiments. This preserves their earlier evidence; it is not a new native safety run.

The full repository gate is still required for product changes. The preceding bookkeeping report recorded unfinished readiness/Continue tests (one frontend and two daemon assertions). Archiving diagnostics must not delete, weaken or skip those tests to create a green result. A clean Git worktree means the intended files are committed; it does not mean the unfinished feature is implemented or all tests pass.

Observed archive-preparation verification:

- `shasum -a 256 -c docs/research/omp-external-adapter-evidence.sha256`: all **29 OK**.
- `node --check` for each frozen file: **29 passed**.
- Inventory/config consistency: every frozen file classified; exactly those 29 filenames excluded; original bytes unchanged.
- `./scripts/check.sh`: Biome **passed** (237 files, no fixes); both typechecks **passed**; Vitest **1606 passed, 2 failed**, so the command exited 1 before extension/Rust/shell suites.
- Both failures were in untouched `CreateTaskPage.test.tsx`: `uses graph destinations rather than step order and submits an explicit manual choice` (known missing Continue UI) and `requires an explicit committed alternative on an unborn checkout` (Create task remained disabled). The latter was not in the preceding fix report's failure list; no cause or intermittent-test classification is inferred here. Neither test was altered, skipped or suppressed.

Build/D1–D6 remain incomplete. No native runtime change, launcher migration, deployment or Playbook advancement is part of this archival commit.
