# Playbook v1 definition decision ledger

> Planning snapshot captured on 2026-09-04 from [DEL-624](https://linear.app/delegance/issue/DEL-624/implement-the-playbook-execution-engine) and [DEL-625](https://linear.app/delegance/issue/DEL-625/define-playbook-parsing-validation-and-version-identity) for [PR #237](https://github.com/DeleganceAI/saga/pull/237).
>
> The Playbook definition grill is complete and shared understanding was confirmed. This file preserves the decisions independently of Linear. It specifies planned v1 behavior; it does not claim that implementation has begun. Ledger statuses are preserved exactly: `Settled` is binding, while `Provisional`, `Proposed`, and `Open` remain unresolved at the epic level.

## Executive summary

- A Playbook is one self-contained Markdown file with restricted YAML frontmatter and ordinary Markdown Step instructions.
- `schema: alinery.playbook/v1` identifies the file format.
- SHA-256 of the exact entire file identifies its Playbook version. Any byte edit creates a new version; byte-identical files have the same version.
- There is no authored `version`, manual counter, Step-definition version, revision identity, or formatting-insensitive semantic digest.
- The schema is closed and fail-fast except for the deliberately open-ended Step `settings` mapping.
- Inputs are positive, bindable, flat, and AND-only. There is no `when`, OR, XOR, negation, variable, or general expression language.
- Artifact selectors support exact logical paths or one nonrecursive `*` in the final segment. A Step may have at most one ordinary wildcard input, which is its fan-out axis. `complete:` inputs are joins rather than fan-out axes.
- Outputs are required declarations but advisory at runtime. Missing declared outputs and undeclared actual outputs warn; neither rejects an otherwise valid completion.
- Declared inputs determine only material eligibility and the exact binding. Claim acquisition and Session scheduling are separate gates.
- A Session runs in an isolated writable workspace materialized from one exact selected parent State or a runtime-derived parent-State set. Accepted completion seals one new immutable State.
- An artifact occurrence is `(origin State hash, normalized logical path, content hash)`. An application claim is keyed by `(Playbook hash, Step ID, exact input-occurrence binding)`.
- One Run-wide switch controls automatic reruns after materially changed inputs. It defaults off, does not affect first applications, is checked when recurrent claims are considered, and never cancels already-claimed work.
- Only top-level regular `*.md` files in `<repo>/.alinery/playbooks/` are discovered. A user selects a concrete repository-relative file; duplicate authored Playbook IDs are valid.
- At first attachment to a Task, the selected file is reread, validated, hashed, and stored exactly. That Task remains pinned to those bytes and hash until an explicit future migration.

## Normative v1 source contract

### Minimal valid Playbook

```markdown
---
schema: alinery.playbook/v1

playbook:
  id: one-shot
  description: Complete one request.

steps:
  - id: complete-request
    harness: codex
    model: gpt-5.6-sol
    inputs:
      - ticket.md
    outputs:
      - result.md
---
# One Shot

<a id="complete-request"></a>
## Complete Request

Read `ticket.md`, perform the request, and publish `result.md`.
```

### Closed field tree

| Location | Required | Optional or open |
| -- | -- | -- |
| Frontmatter | `schema`, `playbook`, non-empty `steps` | None |
| `playbook` | `id` | `description` |
| Each Step | `id`, `harness`, `model`, non-empty `inputs`, non-empty `outputs` | `settings`, `completion` |
| `completion`, when present | Boolean `human_approval` | None |
| `settings` | None | Any string-keyed values expressible in the restricted YAML subset |

`schema` must equal `alinery.playbook/v1`. `playbook.description`, when present, is a string; omission means there is no authored summary. Required `harness` and `model` values are non-empty strings. Step IDs must be unique within the file. `settings` is the only open mapping; all other mappings reject unknown fields. Valid `settings` are preserved and applied best-effort for the declared harness; unsupported or incompatible entries warn rather than invalidating the Playbook.

There are no authored `title`, `instructions`, `version`, `revision`, `status`, `when`, `defaults`, `collections`, parent-count, or merge fields.

`completion`, when present, contains exactly `human_approval: <boolean>`. `true` requests approval; `false` or omitted `completion` does not. Parsing preserves this declaration. Approval enforcement belongs to its owning implementation track and is not settled here.

### Exact bytes and frontmatter

- The source must be BOM-free, strictly valid UTF-8.
- The engine reads once as bytes, hashes and preserves that exact buffer, then decodes the same buffer. It does not guess an encoding, insert replacement characters, strip a BOM, or normalize Unicode.
- The exact entire-file SHA-256 is the Playbook version identity. Any byte edit creates a new version. Identical bytes produce the same version.
- The UI normally hides that hash; diagnostics may show a short prefix.
- LF and CRLF are accepted and are not normalized before hashing, so otherwise identical LF and CRLF files have different identities. Lone CR is rejected.
- Canonically equivalent Unicode spellings with different valid UTF-8 bytes remain distinct Playbook versions.
- Golden vectors must pin the distinct exact-byte hashes of LF and CRLF variants, cover byte-distinct valid Unicode spellings, and cover accepted and rejected parsing cases.
- The first decoded line must be exactly `---`. The first subsequent decoded line whose entire content is exactly `---` closes frontmatter.
- Content before the opening fence, whitespace on either fence, and `...` as a closer are invalid.
- No blank line is required after the closing fence. Every following byte belongs to the Markdown body and contributes to the file hash.
- Invalid definitions fail closed before execution. An unsupported schema, unknown field outside `settings`, malformed value, or repeated mapping key never produces a partially usable definition.
- Future schema changes require an explicit migration process; v1 does not guess compatibility.

### Restricted YAML

Frontmatter permits mappings and sequences with string keys and string, boolean, or decimal-integer scalar values. Other scalar spellings must be valid strings or are rejected.

- Boolean literals are lowercase `true` and `false`.
- Decimal integers match `-?(0|[1-9][0-9]*)`.
- Repeated keys at any nesting level are invalid; neither first-wins nor last-wins behavior is allowed.
- Anchors, aliases, merge keys, tags, directives, nulls, floats, dates or timestamps, complex keys, and additional YAML documents are invalid.

### Markdown binding

- The body must contain exactly one parsed ATX H1 outside code blocks. Its non-empty heading text is the Playbook display title. Setext headings do not count.
- Every Step binds to exactly one literal `<a id="step-id"></a>` anchor whose ID equals the Step ID and which immediately precedes a parsed ATX H2 outside code blocks.
- The H2's non-empty heading text is the Step display title.
- The Step's instructions start at that H2, include the heading and all following content and H3+ subsections, and end before the next H1 or H2 or at EOF.
- The locator anchor is not part of the extracted instructions.
- H2 sections not bound to Steps are valid documentation.

### IDs, artifact paths, and selectors

Playbook and Step IDs match:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

V1 adds no separate identifier-length limit. Step IDs are unique only within one Playbook; there are no cross-version Step-ID immutability rules.

A canonical exact artifact path is a relative, `/`-separated sequence whose components match:

```text
[a-z0-9]+(?:[._-][a-z0-9]+)*
```

V1 rejects rather than rewrites absolute paths, empty or dot segments, repeated or trailing `/`, backslashes, uppercase, spaces, Unicode, and leading or trailing punctuation.

An artifact selector is either a canonical exact path or a relative path containing exactly one literal `*` in its final segment. The wildcard matches zero or more characters within that segment and never `/`; a resulting artifact path must satisfy the canonical path grammar. Recursive globs, `?`, character classes, alternation, captures, interpolation, and regular expressions are invalid.

Exact duplicate entries within one Step's `inputs` or `outputs` are invalid. Distinct selector overlaps are accepted; their runtime binding behavior belongs to the evaluator.

### Inputs, branching, fan-out, and joins

Every Step has a non-empty `inputs` list. An entry is either an artifact-selector string or a one-key complete-set mapping:

```yaml
inputs:
  - ticket.md
  - request-*.md
  - complete: result-*.md
```

- Every input is positive and bindable. All entries have AND semantics.
- There is no `when`, OR, XOR, negation, absence check, recursive expression, authored runtime variable, dotted member field, or general collection-member schema.
- Different branches are ordinary Steps with different positive input contracts. A producer chooses branches by publishing the artifact names that satisfy them. If multiple branch artifacts are present, every corresponding Step is eligible; the engine adds no implicit exclusivity, priority, XOR, or "failure wins" rule.
- When one downstream Step should interpret alternatives, a producer can encode the alternative in one stable artifact's contents.
- A Step may have several exact inputs but at most one ordinary wildcard input. That wildcard is the sole fan-out axis and creates one application per exact matching occurrence alongside the same exact-path bindings.
- Multiple ordinary wildcard inputs are invalid rather than implying a Cartesian product, filename pairing, or hidden join rule.
- A Step may have multiple `complete:` entries, including wildcard selectors. They are joins, not fan-out axes.
- Each `complete:` entry requires accepted corresponding result coverage for every occurrence in the same exact finite produced set. Multiple entries intentionally require multiple result lanes over that set.
- A `complete:` input produces no binding when its finite set is empty; v1 has no vacuous empty-set execution. Empty or alternative outcomes use explicit positive artifacts such as `no-items.md` or `fail.md` to make another Step eligible.
- One matching result is insufficient when an expected occurrence remains uncovered.
- The finite set and its coverage are derived from immutable State-graph provenance: explicitly produced paths, exact descendant input bindings, and accepted outputs. No remembered group, mutable completeness ledger, or cache is semantic authority.
- A producing Session writes every output it actually publishes before one successful completion request. Accepted completion seals the full finite output set atomically, so downstream evaluation never observes a partial publication.

### Advisory outputs

Every Step has a non-empty `outputs` list of artifact-selector strings. `complete:` is valid only in `inputs`.

- Output declarations support a possible pre-run dependency graph, prompt guidance, and diagnostics.
- Declarations do not create occurrences or satisfy inputs. Accepted publication is the only material runtime authority.
- V1 has one advisory output list, not separate `required` and `possible` lists.
- A declared selector matching no published artifact produces a non-blocking warning and does not reject completion.
- A published artifact matching no declared selector remains valid and authoritative, receives its normal occurrence, can satisfy downstream inputs, and produces a non-blocking warning.
- A future schema may introduce hard required-output contracts if evidence demands them.

### Discovery, selection, and pinning

- Discover only top-level regular `*.md` files in `<repo>/.alinery/playbooks/`.
- Built-in Playbooks are installed or copied into that same directory rather than forming a second runtime source.
- V1 has no global Playbook directory, recursive discovery, or symlink following.
- The user selects one concrete repository-relative source file. The filename need not match `playbook.id`.
- `playbook.id` is an authored slug, not a catalog-wide primary key or launch lookup key. Duplicate Playbook IDs across files are valid. V1 exposes no bare-ID-only launch.
- Immediately before a Playbook is first attached to a Task, the engine rereads, validates, hashes, and stores the exact selected file bytes on that Task.
- Later work and any Runs on that Task use its stored snapshot until explicit migration. Task-to-Run cardinality remains outside this track.
- An invalid discovered file remains visible with an actionable diagnostic but cannot be newly attached. A deleted file disappears from discovery. There is no cached last-known-good fallback.
- Repairing or recreating a source makes it available again. Existing Tasks retain their stored bytes and hash and are unaffected.

## Execution semantics fixed by this grill

These decisions constrain the parser's model and the later State, evaluator, workspace, Session, and scheduler tracks.

### State and workspace

- Accepted task history consists of immutable States connected by explicit parent relationships. Unpublished execution work is isolated from that history.
- Every Step execution selects one or more exact immutable parent States. There is no single global "current State" after branching.
- If one State supplies all exact bound occurrences, execution is an ordinary one-parent transition. If several supplying States are required, execution is a merge with those States as parents.
- The Playbook declares required inputs, not parent count. V1 has no `merge:` flag, authored parent list, or separate merge Step type.
- Multiple parents support both fixed-input sibling merges and dynamic complete-set joins.
- Parentage is derived from immutable State provenance and exact bindings, never hidden mutable merge memory. The exact parent-set selection and workspace merge rules remain for their owning track.
- The engine materializes one isolated writable workspace from the selected parent State or parent-State set, then starts the execution's Session or Sessions there.
- A Session does not run inside an immutable State and is not merely handed a pointer to a remote State. It can inspect the entire materialized workspace.
- Declared inputs are not filesystem access restrictions; they determine only eligibility and exact binding. Step instructions point the agent toward those exact bound inputs and the current execution workspace.
- Intermediate edits stay unpublished in the workspace. Only accepted, engine-validated completion seals one new immutable State. Failed, rejected, or continuable execution publishes none.

### Publication, occurrence, binding, and claim

1. **Content hash:** identifies the exact artifact bytes.
2. **Publication:** the successful event where the engine accepts a candidate workspace, seals it as a new immutable State, and exposes that State to Playbook evaluation. It is not a separately numbered object.
3. **Occurrence:** identifies which publication produced a logical artifact value: `(origin State hash, normalized logical path, content hash)`.
4. **Binding:** identifies the exact occurrence or occurrences a Step application uses.
5. **Claim:** records whether that exact application may be scheduled.

Paths explicitly produced by a publication receive new occurrences. Other paths retain their inherited occurrences. No separate publication ID or occurrence counter is required. State identity must commit to parentage and the producing action rather than only workspace bytes, while excluding self-derived occurrence references from its own hash input.

### Eligibility, claimability, and scheduling

- A Step is eligible relative to one exact State or exact parent-State set when every declared input binds across that selection.
- Eligibility is purely material. Runtime policy, claims, active execution, and scheduler capacity do not change whether the inputs are satisfied.
- Automatic claimability is a separate Run-level decision. Claim acquisition happens before scheduler capacity is applied.
- The automatic claim key is `(Playbook hash, Step ID, exact input-occurrence binding)`.
- Claim acquisition is atomic and durable. Inheriting the same occurrences preserves the same key, preventing an equivalent automatic execution from being scheduled again while that claim exists.
- The ordinary progression is: `inputs satisfied -> claim acquired -> Session scheduled`.
- Claims and runtime policy are explicit Run-control state; they are not artifacts or execution markers copied into immutable material States.

### Changed-input recurrence

- Claim identity and automatic recurrence are separate concerns.
- Same-byte republication creates new provenance but does not automatically rerun a consumer.
- If any bound input's content hash differs from its immediate predecessor, the binding is materially changed and may rerun when Run policy permits it. Reverting to older bytes still counts as a change from the immediate predecessor.
- V1 does not deduplicate recurrence against every content hash ever seen in the Run.
- One mutable Run-wide switch controls automatic reruns after materially changed inputs. There are no per-Step overrides.
- New Runs default the switch to off. First eligible applications remain automatic; the switch controls repeat applications only.
- The evaluator reads the switch's current value whenever it considers acquiring a recurrent automatic claim. It is not snapshotted at Run start or publication time.
- Recurrent claim acquisition is the v1 commitment boundary. Turning the switch off prevents only future recurrent claims; already-claimed queued and running applications continue. The toggle never withdraws claims or interrupts Sessions.
- Turning the switch on runs the ordinary evaluator over the candidate States it currently considers. Eligible unclaimed repeat applications use the existing claim algorithm. There is no replay procedure, missed-change ledger, enablement watermark, or separate eligibility rule.

## Shared decision ledger

| ID | Decision | Status | Owning track | Affected tracks |
| -- | -- | -- | -- | -- |
| D-001 | Playbooks replace the workflow execution model rather than forming a permanent second scheduler. | Settled | 9 | 3, 5, 6, 8 |
| D-002 | Pure Playbook semantics belong in `alinery-core`; one evaluator is hosted by `alineryd`. | Provisional | 6 | 2-9 |
| D-003 | OMP and PTY ownership remains exclusively in `alineryd`. | Settled | 5 | 4, 6 |
| D-004 | A Step execution and Session are separate identities. | Settled | 5 | 2, 4, 6-8 |
| D-005 | Process exit is not Step completion. | Settled | 5 | 4, 6, 7 |
| D-006 | Human approval freezes and approves an exact candidate before State publication. | Proposed | 7 | 2, 4-6, 8 |
| D-007 | The execution-environment facts that belong in authoritative provenance remain open. | Open | 1 | 2, 5, 6 |
| D-008 | Canonical storage and crash-publication protocol. | Open | 2 | 3-8 |
| D-009 | A Playbook is one hybrid Markdown file: restricted YAML frontmatter carries machine-readable orchestration and ordinary Markdown body sections carry Step-authored instructions. Its exact whole-file SHA-256 is its version identity; there is no authored version counter or semantic digest, and existing Tasks retain their exact file and hash until explicit migration. | Settled | 1 | 2-8 |
| D-010 | Each Step execution selects one or more exact immutable parent States, materializes that runtime-derived parent selection as one isolated writable workspace, runs Sessions there, and publishes a new immutable State only after accepted completion. | Settled | 4 | 2, 3, 5, 6, 8 |
| D-011 | Declared inputs determine only Step eligibility and exact binding; they are not visibility restrictions over the selected parent State. | Settled | 3 | 1, 2, 4-6, 8 |
| D-012 | Inputs are one flat AND-only list. OR is omitted because the engine evaluates Steps independently: different positive artifact outputs may make different Steps eligible, while one stable artifact may carry alternatives when a single downstream Step should interpret them. This avoids a second control-flow language in the Playbook schema. | Settled | 1 | 2, 3, 5, 6, 8 |
| D-013 | V1 omits `when` because it duplicates `inputs`. All declared inputs binding is the sole automatic readiness condition; durable claim acquisition and Session scheduling remain separate later gates. | Settled | 1 | 3, 5, 6, 8 |
| D-014 | `eligible` is the material fact that all declared inputs bind across one exact immutable parent State or a runtime-derived exact parent-State set. Runtime policy and durable claims separately determine whether the eligible application is claimable; scheduling follows claim acquisition. | Settled | 3 | 1, 2, 5, 6, 8 |
| D-015 | Publication is the successful State-sealing event, not a separate runtime object or counter. An occurrence is `(origin State hash, normalized logical path, content hash)`; inheritance preserves that tuple. State identity includes parentage and producing-action provenance but excludes self-derived occurrence references. | Settled | 2 | 1, 3-6, 8 |
| D-016 | Automatic claims are keyed by `(Playbook hash, Step ID, exact input-occurrence binding)` and acquired atomically before scheduling. Inheritance reuses the claim. Auto-recurrence separately compares each input with its immediate predecessor: same bytes do not auto-rerun, while any actual change, including reversion, may rerun when Run policy permits. | Settled | 2 | 1, 3, 5, 6, 8 |
| D-017 | Changed-input automatic reruns are controlled by one mutable Run-wide switch in v1, with no per-Step overrides. It affects repeat applications only and is read each time the evaluator considers a recurrent automatic claim; first eligible applications remain automatic. | Settled | 6 | 1-3, 5, 8 |
| D-018 | For v1, recurrent claim acquisition is the commitment boundary. Disabling automatic reruns prevents only future recurrent claims; already-claimed queued and running applications continue, and the toggle never withdraws claims or interrupts Sessions. | Settled | 6 | 1-3, 5, 8 |
| D-019 | New Runs default changed-input automatic reruns to off. First eligible Step applications remain automatic; only repeat applications require deliberate opt-in. | Settled | 6 | 1-3, 5, 8 |
| D-020 | Enabling changed-input automatic reruns triggers the ordinary evaluator over its current candidate States. Eligible unclaimed repeat applications use the existing claim algorithm; v1 adds no separate replay procedure, missed-change ledger, enablement watermark, or new eligibility rule. | Settled | 6 | 2, 3, 8 |
| D-021 | V1 accepts LF and CRLF Playbook line endings, rejects lone CR, and hashes the original bytes without line-ending normalization. Otherwise identical LF and CRLF files are distinct Playbook versions. | Settled | 1 | 2, 4, 8 |
| D-022 | Playbook source is BOM-free, strictly valid UTF-8. One exact byte buffer is hashed, preserved, and decoded without guessing, replacement, or Unicode normalization; distinct valid Unicode byte encodings remain distinct Playbook versions. | Settled | 1 | 2, 4, 8 |
| D-023 | V1 has no author-defined runtime variables, dotted member-field expressions, or general collection-member schemas. A successful producing completion atomically seals its full finite output set; declared artifact-path patterns select exact occurrences for one-application-per-occurrence fan-out, while complete-set joins preserve the exact produced request set. | Settled | 1 | 2-6, 8 |
| D-024 | A v1 artifact selector is either an exact normalized relative path or contains exactly one nonrecursive `*` in its final path segment. `*` never matches `/`; recursive globs, `?`, character classes, alternation, captures, interpolation, and regex are excluded. | Settled | 1 | 2-5, 8 |
| D-025 | A Step may have multiple exact-path inputs but at most one ordinary wildcard input. That wildcard is its sole fan-out axis, producing one application per matching occurrence with the same exact-path bindings. Multiple ordinary wildcards are rejected; wildcard `complete:` entries remain joins rather than fan-out axes. | Settled | 1 | 2, 3, 5, 8 |
| D-026 | An input list may contain multiple explicit `complete: <artifact-selector>` entries. Each requires accepted result coverage for every occurrence in the same exact finite source set; multiple entries intentionally join multiple result lanes. Completeness and exact bindings are derived from immutable State-graph provenance, never a hidden remembered group or mutable completeness ledger. | Settled | 1 | 2-6, 8 |
| D-027 | A Step execution may select one or more exact immutable parent States. One parent is ordinary execution; multiple parents support both fixed-input merges across sibling States and dynamic complete-set joins. This relaxes the earlier one-parent-only rule. Parentage is derived from immutable State provenance and exact input bindings, never hidden mutable merge memory; parent-set selection and workspace merge rules remain open. | Settled | 1 | 2-6, 8 |
| D-028 | A Playbook declares required inputs, not parent count. At runtime, one State supplying all exact bound occurrences yields ordinary one-parent execution; multiple supplying States yield a merge with those States as parents. No `merge:` flag, authored parent list, or separate merge Step type is required. | Settled | 1 | 2-6, 8 |
| D-029 | A `complete` input grounds no application when its exact finite source set is empty; v1 has no vacuous empty-set execution. For a non-empty set, every expected occurrence must have accepted result coverage, not merely one matching result. Empty or alternative outcomes use ordinary positive artifacts that independently make other Steps eligible, so OR input syntax is unnecessary. | Settled | 1 | 2, 3, 5, 6, 8 |
| D-030 | If distinct positive triggers are simultaneously satisfied, every corresponding Step is eligible. The engine adds no implicit exclusivity, XOR, priority, or "failure wins" rule; a producer that requires mutually exclusive branches must publish only the intended trigger. | Settled | 1 | 2, 3, 5, 6, 8 |
| D-031 | Repeated YAML mapping keys at any frontmatter nesting level are invalid. The parser never applies first-wins or last-wins behavior. | Settled | 1 | 2, 5, 8 |
| D-032 | A Playbook's first decoded line must be exactly `---`; the first subsequent decoded line whose entire content is exactly `---` closes frontmatter. Content before the opener, whitespace on either fence, and `...` as an alternative closer are invalid; LF and CRLF remain governed by the exact-byte rules. | Settled | 1 | 2, 5, 8 |
| D-033 | No blank line is required after the closing frontmatter fence. Every following byte is Markdown; whitespace there still contributes to the exact whole-file hash. | Settled | 1 | 2, 5, 8 |
| D-034 | YAML frontmatter is restricted to mappings and sequences with string keys and string, boolean, or decimal-integer scalar values. Anchors, aliases, merge keys, tags, directives, nulls, floats, dates or timestamps, complex keys, and additional YAML documents are invalid. | Settled | 1 | 2, 5, 8 |
| D-035 | V1 retains machine-readable Step output declarations for the possible pre-run dependency graph, prompt guidance, and diagnostics. Declarations do not create occurrences or satisfy inputs; accepted publications remain the sole material runtime authority. | Settled | 1 | 2, 3, 5, 8 |
| D-036 | `outputs` is one advisory list of expected artifact selectors. V1 has no `required`/`possible` distinction. A declared selector matching no published artifact produces a non-blocking warning but never rejects completion; a future schema may add hard requirements if evidence demands them. | Settled | 1 | 2, 3, 5, 8 |
| D-037 | Each `outputs` entry uses the ordinary artifact-selector grammar: one exact normalized relative path or one nonrecursive `*` in the final path segment. `complete:` is valid only in `inputs`. | Settled | 1 | 2, 3, 5, 8 |
| D-038 | A publication outside the Step's advisory `outputs` remains valid and authoritative, creates its normal occurrence, and may satisfy downstream inputs. The engine records a non-blocking warning; it does not reject completion or suppress the publication. | Settled | 1, 4 | 2, 3, 5, 6, 8 |
| D-039 | Playbook IDs and Step IDs must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. V1 adds no separate identifier-length limit. | Settled | 1 | 2, 3, 5, 8 |
| D-040 | V1 has no authored `instructions` field. Each Step automatically binds to exactly one literal HTML anchor whose `id` equals the Step ID and which immediately precedes the corresponding H2 instruction section. | Settled | 1 | 2, 4, 5, 8 |
| D-041 | A Step's authored instruction text starts at its same-ID H2, includes that heading and all nested content, and ends before the next H1 or H2 or at EOF. The locator anchor is excluded; unreferenced H2 sections remain valid documentation. | Settled | 1 | 2, 4, 5, 8 |
| D-042 | Every v1 Step explicitly declares `harness` and `model`. V1 has no Playbook-level execution defaults, inherited Step fields, or override-resolution rules; `settings` remains optional. | Settled | 1 | 4, 5, 8 |
| D-043 | Every v1 Step must declare at least one material input. Zero-input Steps and implicit run-at-start behavior are excluded; entry Steps bind an explicit seed artifact. | Settled | 1 | 2, 3, 5, 6, 8 |
| D-044 | V1 has no authored Step `title` field. The Step ID remains its machine-readable slug and anchor identity; the bound H2 supplies its human-readable display title. | Settled | 1 | 4, 5, 8 |
| D-045 | V1 has no authored Playbook `title` field. The Playbook ID remains its machine-readable slug; exactly one Markdown H1 supplies its human-readable display title. | Settled | 1 | 8 |
| D-046 | V1's only completion-source declaration is optional boolean `completion.human_approval`: `true` requests approval, while `false` or omitted `completion` does not. The former `focus`/`guidance` object is excluded; guidance belongs in Step Markdown. | Settled | 1 | 5, 7, 8 |
| D-047 | V1 retains optional `playbook.description` string metadata as the authored concise summary; omission means no summary. | Settled | 1 | 8 |
| D-048 | V1 has no `playbook.status` field. Editorial maturity and catalog or publication lifecycle state remain outside the immutable Playbook source. | Settled | 1 | 8 |
| D-049 | Optional Step `settings` is open-ended: any string key and any value allowed by the restricted YAML subset is preserved. The engine applies settings best-effort for the declared harness; unsupported or incompatible entries produce non-blocking warnings rather than invalidating the Playbook. | Settled | 1 | 5, 8 |
| D-050 | Every v1 Step declares a non-empty advisory `outputs` list. Definition-level requiredness does not make any declared artifact mandatory at completion; missing declared outputs retain warning-only behavior. | Settled | 1 | 3-5, 8 |
| D-051 | Canonical artifact paths are relative `/`-separated components matching `[a-z0-9]+(?:[._-][a-z0-9]+)*`; v1 rejects rather than normalizes all other forms. Wildcard selectors retain exactly one `*` in the final segment and otherwise obey the same grammar. | Settled | 1 | 2-5, 8 |
| D-052 | V1 discovers only top-level regular `<repo>/.alinery/playbooks/*.md` files. Built-ins are installed or copied there; v1 has no second bundled runtime source, global directory, recursive discovery, or symlink following. | Settled | 1 | 5, 8 |
| D-053 | At first Playbook attachment to a Task, one selected repository-relative source file is reread, validated, hashed, and stored exactly on that Task. `playbook.id` is an authored slug rather than a catalog key: filenames need not match, duplicate IDs are valid, and v1 has no bare-ID-only launch. Later work on that Task uses its stored snapshot until migration; Task-to-Run cardinality remains outside this track. | Settled | 1 | 2, 3, 5, 6, 8 |
| D-054 | Invalid discovered Playbooks remain visible with actionable diagnostics but cannot be newly attached to a Task; deleted sources disappear. V1 never substitutes cached last-known-good bytes. Repair or recreation restores availability, while Tasks with stored snapshots remain unaffected. | Settled | 1 | 5, 8 |
| D-055 | The v1 field tree is closed except beneath Step `settings`: top-level `schema`, `playbook`, and non-empty `steps`; `playbook` requires `id` and permits optional `description`; each Step requires `id`, `harness`, `model`, non-empty `inputs`, and non-empty advisory `outputs`, with optional open-ended `settings` and optional boolean `completion.human_approval`. All other source fields are invalid. | Settled | 1 | 2, 3, 5, 8 |

## Explicit boundaries and follow-up ownership

The definition grill is complete. These items were deliberately left to their owning tracks rather than silently decided here:

- D-002 remains provisional: final evaluator placement and production architecture.
- D-006 remains proposed: exact candidate-freezing and enforcement semantics for human approval. This file settles only the source shape `completion.human_approval`.
- D-007 remains open: which execution-environment facts enter authoritative provenance.
- D-008 remains open: canonical State storage and crash-publication protocol.
- Parent-set selection, workspace merge rules, candidate-State selection, failure, cancellation, continuation, retry, manual-run identity, scheduler capacity, and Task-to-Run cardinality remain outside the definition track.
- The existing PR #237 Playbooks demonstrate the hybrid Markdown/frontmatter envelope but use `schema: alinery.playbook/sketch-0` and other non-v1 fields. They are intentionally nonconforming until [DEL-635](https://linear.app/delegance/issue/DEL-635/simplify-pr-237-playbooks-to-artifact-based-fan-out) migrates them.
- [DEL-636](https://linear.app/delegance/issue/DEL-636/implement-the-playbook-v1-parser-validator-and-exact-byte-identity) owns the parser, validator, Markdown binding, exact-byte preservation, SHA-256 identity, and golden vectors.
- [DEL-637](https://linear.app/delegance/issue/DEL-637/implement-repository-playbook-discovery-and-validated-source-snapshots) owns repository discovery and the first-attachment exact-byte Task snapshot, and is blocked by DEL-636.
- Runtime `settings` warnings, completion-time output warnings, evaluator behavior, Task persistence, Session behavior, approval enforcement, and UI presentation remain with their existing owning tracks.

No implementation is included in this planning snapshot.
