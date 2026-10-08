# Alinery Playbook example

`playbook.md` is a complete v2 Playbook with six agent operations. It uses the whitepaper branch's production syntax and parser. `build_playbook.py` generates the definition from the canonical prompts in `../shared/prompts.json` plus the explicit file-handoff mappings in that script. The delivered Playbook itself has no runtime dependency on the generator or shared JSON files.

## Install for live use

Use an Alinery build compatible with this source snapshot. The repository library at this snapshot stores each Playbook at `.alinery/playbooks/<key>/playbook.md`. From the comparison bundle, copy into the intended research repository, setting its path explicitly:

```sh
review_repo=/absolute/path/to/research-repository
mkdir -p "$review_repo/.alinery/playbooks/matched-literature-review"
cp alinery/playbook.md "$review_repo/.alinery/playbooks/matched-literature-review/playbook.md"
```

In Alinery, select that repository and create a task with **Matched Literature Review**. Supply the question in `shared/question.txt`, or another literature-review question, as the task description. Choose an authenticated OMP model/harness configuration with web research tools, enable automatic advancement for all six steps and a session capacity of at least two. Start the task. Honor any existing completion locks; never modify them implicitly to force advancement. This preparation did not launch the desktop app, a daemon, OMP or a live model.

The root `frame` step has no graph inputs and reads the original ticket once. Its `round-request.md` output begins the loop. `discover` publishes either a batch and one request per fresh source, or an explicit empty disposition. `read` binds `each` request; `synthesize` binds the corresponding `complete` assessment collection. `decide` publishes either a fresh round request or the final review. `finish-empty` handles no fresh sources without inventing a vacuous collection join.

All names are logical roles. Alinery assigns physical paths and preserves occurrence provenance. Agents must use those assigned paths, never select the latest file by scanning the artifact directory. The same logical round-request role can be published repeatedly while framing remains outside the loop.

## Native core checks

With Rust/Cargo and an Alinery source checkout:

```sh
python3 alinery/build_playbook.py
python3 alinery/verify.py --alinery-source /absolute/path/to/alinery
```

The verifier creates a temporary Cargo project depending on that checkout's real `alinery-core` crate. Cargo runs offline by default, so dependencies must already be cached; fetch the checkout's workspace dependencies first if needed. It does not edit the product source, Cargo.lock or the main paper. A generated test lockfile and temporary task directories are removed after use. For faster repeated compilation, `CARGO_TARGET_DIR` may point to an existing compatible build cache.

Six cases passed: normal two rounds with jointly eligible reader counts 2 and 1, empty-first, empty-second, failed reader, one reader, and duplicate/blank/previously seen URLs. The test uses production parsing, graph reconciliation, reservation, completion acceptance, and exit confirmation. It verifies current-batch membership, single framing, no duplicate reservations, no partial synthesis, no downstream use before producer exit, fresh-loop bindings, and exactly one final report on successful runs. `../validation/alinery.json` stores the trace.

Only agent outputs and lifecycle start/exit notifications are simulated. Readers are jointly eligible in the native scheduler, but this boundary driver completes them sequentially; it does not test PTYs, daemon behavior or actual concurrency. A failed reader leaves the merge blocked; it does not produce a partial report.

## Enforcement boundary

The Playbook's domain instructions require deduplication, source identity, complete JSON fields, nonempty continuation queries, and exclusive continue/stop publication. The engine enforces declared artifact bindings and handoff rules, not those semantic JSON conditions. The fixture driver writes valid structured outputs according to the common contract. Passing the fixtures therefore does not prove that a live agent will honor every instruction. Smithers/LangGraph/Claude examples add explicit response checks in their host code. This is a documented difference in failure behavior, not an equivalence proof.

The Playbook uses the user's configured OMP provider/model. The other examples use Claude Code; no model-quality, token-cost or latency comparison is claimed. Live inference and the scientific quality of the review remain untested.
