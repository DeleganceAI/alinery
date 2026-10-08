# One Dynamic Literature-Review Process in Four Agent Systems

A separate companion draft for the FAM whitepaper. `process-comparison.tex` is the authoring source; `process-comparison.pdf` is the compiled reading copy. The four implementation appendices and their shared-data appendix now live in [Finite Agent Machines](../playbook-execution-model/v3/playbook-execution-model.pdf). Executable sources and verification evidence remain here. Running the examples needs the documented third-party runtimes and an Alinery source checkout.

## Read and build

The document compares one six-operation process: frame once, discover fresh sources, read one per source, join all current readers, synthesize cumulative evidence, and decide whether to continue. Empty discovery takes a separate terminal route. Complete sources and instructions appear in the whitepaper appendices; the comparison PDF contains the process contract, analysis, and verification scope. Shared prompts/schemas/fixtures are in `shared/`.

```sh
latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir=build process-comparison.tex
cp build/process-comparison.pdf process-comparison.pdf
```

The source bundle preserves the sibling `process-comparison/` and `playbook-execution-model/v3/` directories. To rebuild the whitepaper, which includes the implementation files directly:

```sh
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error -outdir=/tmp/fam-appendices-build ../playbook-execution-model/v3/playbook-execution-model.tex
```

Requires a LaTeX installation with the standard packages named in the preamble. Rendered pages were inspected after compilation. Build intermediates, installed dependencies and virtual environments are excluded from delivery.

## Reproduce the orchestration checks

See each system's `RUNNING.md` for setup and exact standalone commands. After installing the pinned dependencies:

```sh
python3 verify_all.py --smithers-source /absolute/path/to/smithers --alinery-source /absolute/path/to/alinery
```

- Claude Code: 11 compatibility checks only; the script's native runtime was not run. Build and test use Node 26.0.0. The checked CLI was 2.1.289 and signed out.
- Smithers: 13 native in-memory engine checks against source `8fee1a6d88ef0308159cb1c9bd6a462ebf660724`, packages 1.0.0-rc.1; Node 26.4.0 / Effect 4.0.0-rc.115. `smithers/package-lock.json` is included.
- LangGraph: 11 native checks and a fixture CLI run, using 1.2.14 / Python 3.14.5. `langgraph/requirements.lock` pins the full environment.
- Alinery: 6 production-core checks against whitepaper commit `d9768d9a8dbea228860e2a4408f7079a5952e788`, core tree `8155b475cf4179cb93eea45102e3d69cdc41e172`. Simulated lifecycle signals; no app, daemon, PTY or OMP was launched.

No live inference was performed in any system. These examples are source-complete, with launch instructions, but are not four verified end-to-end model runs. `validation/manifest.json` records pins, check scope and file hashes. `validation/equivalence-review.txt` records an independent source/fixture comparison. The product-wide `./scripts/check.sh` was attempted and stopped because the whitepaper checkout lacks `alinery-app/node_modules`.

Fixtures are synthetic and use `example.invalid`. Their reports are explicitly SIMULATED, not research findings. Tests cover both empty branches, runtime reader cardinality, complete-batch barriers, cumulative state, loop routing, failure, and URL deduplication; malformed-output coverage varies by implementation.

## Live use

Each implementation has explicit live instructions in its own `RUNNING.md`. Authenticate the chosen harness normally, then run the desired example with a real question. Do not use fixture sources as research evidence. The process has no fixed round count; native resource limits or operator interruption may end a run. Passing fixtures does not prove convergence, factual accuracy, recovery behavior, or equal guarantees across systems.

Alinery enforces artifact bindings and handoffs, while semantic JSON checks and exclusive route publication are instructions to agents. Other examples add host-language guards. Models, tools and agent context are not held constant, so this is not a quality, cost or latency benchmark.
