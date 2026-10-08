# Claude Code Dynamic Workflow example

This is a native Claude Code workflow script, with six agent operations and a runtime-sized reader fan-out. `matched-literature-review.js` is the complete self-contained deliverable. `workflow.body.js` contains the same process body without embedded constants; `build.mjs` embeds the canonical prompts and JSON schemas from `../shared/`.

## Reproduce the checks

From this directory, with Node 22 or later:

```sh
npm test
```

No npm dependencies or installation are required. The checks used Node 26.0.0; `.node-version` records that version. `runtime.json` records the Claude Code version checked, 2.1.289. The generated file starts with a plain literal `export const meta` and contains no imports, filesystem access, shell calls, timestamps, or randomness.

`checks.json` records eleven passing scenarios: two-round fan-out, empty first round, empty second round, failed reader, one reader, repeated/previously seen URLs, three mismatched reader-identity cases, and empty reports on both stopping routes. The test also checks the exact canonical prompt and schema supplied to every operation, cumulative state passed to the decision, and the barrier before synthesis. Readers must preserve the assigned source's id, URL and title. Failed readers abort the run before synthesis; an inaccessible paper instead produces an honest assessment through the reader prompt. A stopping operation must return a nonblank report.

**These are Node compatibility checks, not native-runtime tests.** The harness removes only the initial `export` keyword and wraps the entire generated script in an async function so Node can parse its native top-level `return`. It executes the process body unchanged, substitutes deterministic fixture outputs for `agent`, and implements the testing `pipeline` with `Promise.all`. This establishes the JavaScript branch and state logic under those shims. It does not establish Claude's native scheduling, permissions, structured-output enforcement, persistence, replay, or model behavior. `checks.json` explicitly records both native-runtime and live-inference verification as false.

## Run natively after authentication is available

Native execution was not attempted: the installed CLI was not signed in. No authentication files were inspected and no sign-in was started. The following are launch instructions, not a record of a successful native run.

Build and install the generated script in this example's project scope:

```sh
npm run build
mkdir -p .claude/workflows
cp matched-literature-review.js .claude/workflows/matched-literature-review.js
claude
```

At the interactive Claude Code prompt, use:

```text
Run /matched-literature-review with args {"question":"How can agent execution follow a reusable process while adapting the number of workers and iterations to discoveries?"}. Execute the saved script unchanged.
```

If the session was already open when the file was copied, run `/reload-skills` first. A Pro account may need Dynamic workflows enabled in `/config`. Use `/workflows` to inspect or stop the run. Do not substitute the fixture URLs for live sources.

For a headless launch from this directory after the copy, use:

```sh
claude -p 'Use the Workflow tool to run the saved matched-literature-review workflow unchanged, with args {"question":"How can agent execution follow a reusable process while adapting the number of workers and iterations to discoveries?"}. Return its final report.' \
  --allowedTools 'Workflow(matched-literature-review),Read,WebSearch,WebFetch' \
  --output-format stream-json --verbose --max-budget-usd 5
```

`Workflow(name)` authorizes the named launch; worker research uses the listed web tools. The CLI's `--help` verified these flags, but this headless command was not run. An allowed-tools list approves listed tools; it is not an exclusive tool list. The canonical prompts instruct workers not to delegate or modify the process, but this command does not establish runtime enforcement of that instruction. Availability, the account's permission rules, and the native runtime's interpretation remain unverified. If a permission denies a required operation, the workflow may fail; the command does not bypass permissions.

## API basis and process semantics

The [official workflow reference](https://code.claude.com/docs/en/workflows) documents the saved-file format, structured `args`, `agent(prompt, {schema, label})`, and `pipeline(items, callback)` used here. It also documents `agent` returning `null` on unrecoverable failure or stopping; this script treats that as a failure, never drops a missing assessment. A completed batch is passed to synthesis; cumulative evidence then reaches the decision agent. A continuing decision increments the round and changes queries. The script has no authored round cap, although Claude's runtime limits and the launch budget can end a live run. Termination is not guaranteed by the process.

The [official SDK cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows) demonstrates headless access through the Workflow tool. The CLI entry point here uses the installed Claude Code runtime directly, without an SDK dependency.
