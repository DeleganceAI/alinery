# Smithers literature-review example

This is an executable example using the actual Smithers `Action`, `Flow`,
`Node`, `Interpreter`, and in-memory `FlowEngine`. The six agent operations
consume the same prompts, output JSON schemas, and fixtures as the other examples.
There is no local scheduler and no top-level LLM supervisor.

`process.mjs` is the complete process definition. Discovery hands off to a new
Smithers round containing one native action per fresh source. `Node.all` joins
the readers before synthesis. The decision action receives cumulative current
evidence; its result selects the native branch that stops or hands off to
discovery again. No fixed worker count or iteration count is used. Empty
discovery calls only the empty-result finisher. A failed reader fails the run,
so synthesis cannot consume a partial batch.

## Install and test

Smithers packages at this revision are unpublished. Clone its exact source next
to this directory, or set `SMITHERS_SOURCE` to an existing checkout at that SHA:

```sh
git clone https://github.com/smithersai/smithers.git ../smithers-source
git -C ../smithers-source checkout 8fee1a6d88ef0308159cb1c9bd6a462ebf660724
npm ci --no-audit --no-fund
npm test
```

For an existing checkout:

```sh
SMITHERS_SOURCE=/absolute/path/to/smithers npm test
```

The dependency lock pins Node 26.4.0 and Effect 4.0.0-rc.115. The Smithers source
packages identify themselves as 1.0.0-rc.1; the Git SHA is the authoritative pin.
`register.mjs` verifies that SHA and resolves unpublished package exports to
their unmodified TypeScript source. It does not implement execution behavior.
Node executes that upstream source using its native TypeScript stripping.

`test-report.json` records thirteen successful native-engine scenarios: two readers
then one reader then stop, empty first round, empty second round, failed reader,
one reader, exact-URL de-duplication across and within rounds, and seven invalid
agent-output cases (changed framing question, noninitial frame state, wrong
reader identity, changed reader title, blank continuation query, blank stop report,
blank empty report). Assertions
cover overlapping readers, full-batch synthesis barriers, cumulative decision
state, repeated discovery, and the final result. All fixture findings are
synthetic and use `example.invalid`; fixture tests make no model or web calls.

## Live agents

Authenticate Claude Code separately using its normal supported setup. Then run:

```sh
SMITHERS_SOURCE=/absolute/path/to/smithers npm run live -- 'Your research question'
```

`agents.mjs` launches a fresh `claude -p` process for every operation, passes the
shared instruction and JSON input, requests the shared output schema, and
validates the returned `structured_output`. Discovery and reading have
`WebSearch` and `WebFetch`; other operations have no tools. This uses Claude
Code's local configured model. There is no implicit model choice in Smithers.
Each child is tied to the action's abort signal. Interrupt the command to stop
an unbounded live review; convergence is not guaranteed.

Live inference was not tested: Claude Code 2.1.289 was installed but not
authenticated. No login was started. CLI flags were checked against local help.

## Verification boundary

Only model responses are fixtures. Smithers graph construction, branch selection,
dependency execution, concurrency, and trampoline handoffs execute in the actual
upstream runtime. The low-level interpreter uses process-local callback identity
and the runtime is in memory. This example does not establish durable restart,
cross-process replay, stable callback captures, or production deployment.
Smithers' declared primary platform is Linux; this fixture run used macOS.
The live Claude adapter, literature quality, and network-source access remain
unverified until a separately authenticated live run.
