# LangGraph literature-review example

This is a complete executable example on **LangGraph 1.2.14**, the current PyPI release resolved on 2026-10-07 UTC. `requirements.lock` pins the complete installed dependency set, including JSON Schema validation. Verification used Python 3.14.5 on macOS arm64. The shared prompts, schemas and synthetic fixtures live in `../shared/`; retain that sibling directory when copying this example.

`process.py` is the entire authored process. It has six operation definitions. Native `Send` creates one reader invocation per fresh source discovered at runtime. All these readers occupy the same LangGraph super-step; the next super-step invokes synthesis once, after all readers succeed. The `reads` channel accumulates tagged results through a reducer; synthesis selects the current round and preserves discovery order. Empty discovery takes a separate edge to `finish_empty`. A continuation returns to the same discovery node with updated state. No external scheduler or compatibility shim implements these decisions.

`agents.py` supplies I/O adapters. Fixture mode returns the shared synthetic responses, validates their schemas, and records calls. Live mode launches a fresh `claude -p` process for every operation, passes the common prompt and JSON input, and uses the shared output schema. It allows WebSearch/WebFetch, disables customizations with safe mode, and denies other permission requests. No source review is silently dropped: an inaccessible source should produce an assessment that states its limitations, while an operation failure raises and prevents partial synthesis.

From this directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python verify.py
.venv/bin/python run.py --mode fixture --scenario normal --output run.json
```

`verify.py` saves machine-readable evidence in `evidence/`. It executed the actual installed LangGraph engine, not a recreation. Eleven checks passed: normal (two readers, then one), empty-first, empty-second, failed-reader, one-reader, duplicate/previously-seen URLs, changed frame question, changed reader identity, blank continuation query, and blank reports on either terminal route. Timing records establish concurrent reader starts and a complete-batch barrier. In failed-reader, A finishes and B fails; synthesis, decision and final-report production never start. The tests also verify that synthesis sees previous and current evidence separately, and decision sees the newly accumulated state. These are orchestration tests: all literature and agent judgments in fixture mode are explicitly simulated.

For live inference, authenticate Claude Code separately first, then run:

```sh
.venv/bin/python run.py --mode live --question-file ../shared/question.txt --output live-run.json
```

The installed CLI was Claude Code 2.1.289; its `--help` confirmed the flags used by the adapter. **Live inference was not run because the CLI is signed out.** The adapter and structured-output envelope handling are therefore not end-to-end verified against a live agent. Fixture runs require no credentials or network. The example uses LangGraph's default in-memory execution and does not configure durable checkpoints; no restart/recovery claim is made for this example.

`--max-concurrency` defaults to eight eligible simultaneous operations, without fixing the total number of readers. `--step-limit` defaults to 1000 LangGraph super-steps as an operational safety limit. Reaching it raises an error; it is not an agent's scientific stopping decision. There is no hard-coded number of literature-review rounds. Successful termination depends on `decide` or an empty discovery; an operator may interrupt a live run.

Official API sources: [Graph API and Send](https://docs.langchain.com/oss/python/langgraph/graph-api#send), [orchestrator-worker pattern](https://docs.langchain.com/oss/python/langgraph/workflows-agents#orchestrator-worker), [Pregel super-step runtime](https://docs.langchain.com/oss/python/langgraph/pregel), and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).
