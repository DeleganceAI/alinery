# Plan — Show Queued Messages: verdict round-4 fixes

**Scope (decided by the human's comments on `16-verdict-1/review-report.md`): B1, S1, S2, S5, S6, S7, S8, S9.**
**Not in scope: S3, S4, the minor notes, and the ten person checks (no app launch).**

> Transient work plan, checked in at the human's request. `AGENTS.md` keeps `docs/` for living
> references only, so this lives at the repo root and is expected to be dropped or absorbed into the
> PR description when the work lands. Nothing below is implemented yet.

Branch: `wip/show-queued-messages-implementation` (commit `333b8dd5` preserves the whole change).
All work happens in this checkout, in one follow-up commit per step or one at the end (implementer's
choice), never pushed without the human's word.

---

## 0. The human's comments, reviewed

| Comment | Anchored to | Reads as | Action |
|---|---|---|---|
| `c1795624250181` | S3 — shipping note | "Dont do this - we document it else where and know about it protocol changes are normal now" | **Drop S3 entirely.** No shipping note is written anywhere. Protocol churn is routine and documented elsewhere by the team. |
| `c1795624221804` | S4 — inbox read cost | "we accept this unread - drop this one" | **Drop S4 entirely.** The plain per-read inbox fetch is accepted **unmeasured**. Record in the handoff only: the measurement is waived, therefore the plan's conditional cached variant **never fires** — no cache is to be added later on the strength of CO-5. |
| `c1795624295654` | S5 fix line | "Do this yes" | **Implement S5** as the report writes it (prepared message, not caption, at the session pane's two line builders). |
| `c1795624333968` | S9 fix line | "Bump this one to 59 please" | **S9 becomes a renumber, not a negotiation.** This change takes protocol **59**; `58` stays with the other unmerged commit `9a99cb55`. The "decide the ordering" half is resolved by this comment; the shipping-note half is moot (S3 dropped). The remote-runtime rebuild remains (step 7). |

Ambiguities checked and closed:

- **S9's remote runtimes.** The comment answers the ordering question only. The finding's other half
  — remote hosts run daemons from bundled runtime archives that are untracked and stale — is not
  documentation, it is build state, and it is inherent to any protocol bump the team performs. Kept
  as a pre-release checklist item (step 7), **not** a code change and not a note.
- **S8 is not optional.** It is listed by the human alongside B1 and it is the test-shape half of the
  blocking defect. It goes with step 1.
- **"Use subagents to review my recent comments"** was honoured as a review step, not as new Alinery
  sessions: spawning task sessions would have landed them in the wrong repo's task machinery (the
  very problem this task is being rescued from) and the four comments were each cross-checked
  against the code in this session instead. If the human wants reviewer sessions against this plan,
  they can be created against the correct repo after the task is re-anchored.

---

## 1. Current state, verified in this checkout

- The change is **committed** on this branch (37 modified + 7 new files; queue panel, daemon inbox
  read, remove call, history-tool `queued` list, protocol 57 → 58 in the diff, regenerated wire).
- **The suite is red on exactly two tests** (both are the B1 defect):
  - `alinery-app/src/views/ChatView.test.tsx:417` — "Interrupt whose abort call rejects leaves the lines the server already held"
  - `alinery-app/src/views/SessionView.test.tsx:1270` — "an Interrupt whose abort call rejects leaves the lines the server already held" (failing assertion at `:1295`)
- Protocol constants today: `main` = **57**, this diff = **58**, unmerged `9a99cb55` = **58**,
  **59 is free** (verified: no commit anywhere takes it). Only two literals exist:
  `alinery-core/src/protocol.rs:16` and `vinculum-daemon/src/main.ts:78`. No `.proto` or generated
  file carries the number, so a re-bump needs **no** wire regeneration.

---

## 2. Step 1 — B1 (+ S8): the abort cue's rejection lifecycle

### The defect, in one sentence
Every abort path raises `queueCue.current.withdrawn = true` before the abort call; the fold
(`consumeQueueCue` → the `withdrew` filter in `applyVinculumTranscript`) deletes the server's panel
lines while that claim is live; a **rejected** abort withdraws nothing but never retracts the claim,
so the first fold after the call settles deletes the very lines the rejection just restored — and the
daemon never re-sends a queue it never changed.

### 2a. One shared rejection helper (`alinery-app/src/chat/send.ts`, beside `restoreQueuedLine`)

```ts
/**
 * The abort call rejected: it withdrew nothing. Retract the cue's claim before putting the lines back,
 * or the first fold after the call settles takes them again — and the daemon will never re-send a queue
 * it never changed. Every rejection path goes through here; a successful abort keeps the claim.
 */
export function restoreAfterRejectedAbort(cue: QueueAbortCue, state: ChatTranscriptState, held: readonly QueuedPanelLine[]): ChatTranscriptState {
  cue.withdrawn = false;
  return held.reduce((current, line) => restoreQueuedLine(current, line), state);
}
```

(`QueueAbortCue` is already exported from `chatTranscript.ts`.) The helper is what makes S8's
fold-level test possible and puts the cue's lifecycle in one place — the verdict's "the abort cue is
machinery nobody planned… wants a sentence of justification" gets its answer here: one documented
function, same semantics as today's successful-abort path. If the human prefers zero refactoring,
the alternative is four inline `queueCue.current.withdrawn = false;` lines and the S8 scenario moved
into `ChatView.test.tsx`, where the real catch path is reachable. **Do not** change
`consumeQueueCue`, the `withdrew` filter, or the successful-abort behaviour; round-3's tests pin them.

### 2b. The four sites

1. **`views/chatThreadSession.tsx` `abort()` (`:902-918`)** — capture is already above the call; the
   catch's restore becomes `updateTranscript((current) => restoreAfterRejectedAbort(queueCue.current, current, held))`.
2. **`views/chatThreadSession.tsx` `sendNow()` (`:865-890`)** — two fixes: move
   `const held = transcriptRef.current.queued;` **above** `queueCue.current.withdrawn = true`
   (today it is read after the call settles, so a fold in between empties it and the restore is a
   no-op), and on `aborted === false` use the helper:
   `updateTranscript((current) => aborted ? withoutQueued(current) : restoreAfterRejectedAbort(queueCue.current, withoutQueued(current), held))`.
   The send itself still proceeds when the abort was refused (existing behaviour).
3. **`views/SessionView.tsx` `interruptCurrentSession` (`:1123-1152`)** — capture is already above;
   the catch's `setChat` body becomes `const next = restoreAfterRejectedAbort(queueCue.current, current, held)`.
4. **`views/SessionView.tsx` `sendNow()` (`:865-900`)** — the worst site: no capture, no restore at
   all. Capture `const held = chatRef.current.queued;` before raising the cue, wrap `abortSession`
   so a rejection runs `restoreAfterRejectedAbort(queueCue.current, chatRef.current, held)` (then
   `setChat`) and rethrows into the existing catch, which keeps today's behaviour: error shown,
   message not sent. Do **not** change the divergence with the chat thread (which sends anyway);
   that is a product question for the human, not part of this fix.

### 2c. Tests (step 1)

- **Rewrite `chatTranscript.test.ts` "an abort that rejects leaves no latch…" (`:847-861`) — S8.**
  Delete the impossible rescue frame (`queued: [waiting]` after the rejection — the daemon sends the
  queue only when it changes, and a rejected abort changes nothing). Follow the real sequence:
  in-flight queue-less fold filters → rejection (`restoreAfterRejectedAbort`) puts the lines back →
  **queue-less frames only** afterwards, asserting the lines survive. Red before the fix (the latch
  empties them), green after.
- **New (B1): "a frame that folds between the abort call and its rejection still loses nothing"** —
  chat thread; queue a line, Send now, fold a queue-less frame *while* `abortChatThread` is pending,
  then reject: the line is back and a later queue-less frame leaves it. In `ChatView.test.tsx`.
- **New (B1): "a refused Send now in the session pane puts the lines back"** — `SessionView.test.tsx`;
  same shape for site 4, including the queue-less frame after the rejection.
- Keep green untouched: `ChatView.test.tsx:450` ("Send now whose abort call rejects puts the lines it
  dropped back" — passes today because no fold intervenes) and every round-3 cue test. The report's
  scratch measurement stands: the four affected files go **277 passed** with this fix.

---

## 3. Step 2 — S1: recognise the placed message across a settling partial

**Site:** `chatTranscript.ts` `applyVinculumTranscript` (`:685-690`).

**Defect:** the append check requires the *second-to-last* message to equal the held last message. At
a real turn boundary the assistant's streaming partial settles in the same commit window as the
placement, the daemon coalesces both into one frame, the second-to-last differs → the append is not
recognised → the line is only marked stale (phantom panel line, count stays 1, review stays withheld).

**Rule:** a genuine append is "one more message than the client held, and everything the client held
**except its last entry** is unchanged at the same indices". The held last entry is exactly the
streaming partial that may settle in this frame, so it is the one allowed to differ. The appended
message is still gated by the existing trailer-tolerant delivery match (`isDeliveryOf`), so a wrong
guess cannot drop a line it did not become.

```ts
const appended =
  previous !== undefined &&
  page.messages.length === held.length + 1 &&
  held.slice(0, -1).every((message, index) => messageSignature(page.messages[index]) === messageSignature(message))
    ? page.messages[page.messages.length - 1]
    : undefined;
```

(The verdict phrases this as "compare the held list minus its last entry, and keep the existing
delivery match for the last message" — that is the rule above: `held.slice(0, -1)` must match the
page's leading entries index by index.)

**Test:** fold where the previous state ends in a streaming partial that settles in the same fold as
the placement (`chatTranscript.test.ts`): the line is dropped **at once**, the count goes to 0, and a
later frame with the queue minus the id shows nothing. Also re-run the existing delivery-race tests —
they must stay green (their previous last message is unchanged, which the new rule also accepts).

---

## 4. Step 3 — S2: the authoritative first frame spares this client's own line

**Site:** `chatTranscript.ts` `reconcileQueued` (`:748-772`), fed by `sync/transcript.ts:90-107`
(first frame of a connection sets `queueAuthoritative`).

**Defect:** the rule "absence on an authoritative frame means empty" also drops **this client's
unconfirmed line** when the first read lands before the send's commit — the line blinks out and back,
the exact behaviour the no-blink rule exists to prevent. Keep the rule (it is what removes reconnect
ghosts and ends an ended session's panel); it over-reaches only into pending client lines.

**Rule:** on an authoritative frame, server lines the queue omits are still dropped (that is the
ghost case). A client-made line the queue omits is **spared and marked `stale`**; the ordinary
stale-then-drop rule owns it from there (a later omission drops it). Implemented as:

- `if (queued === undefined) return authoritative ? reconcileQueued(lines, [], delivered, false) : [...lines];`
  (the empty-queue reconcile does exactly: server lines gone, stale lines gone, pending client lines → `stale: true`;
  it also lets the delivery match drop the line the fold's appended message became)
- remove `|| authoritative` from the loop's skip condition; everything else in `reconcileQueued` is unchanged.

`QueuedPanelLine` already carries `origin: "server" | "pending"` and `stale`, so no type change.

**Tests:**
- **Rewrite `chatTranscript.test.ts:799`** — "an authoritative frame drops a client line the queue
  omits instead of marking it stale" **pins the over-reach this finding calls a defect**. Replace it
  with the new rule: authoritative frame + omitted queue ⇒ the server line is dropped, the pending
  client line survives as `stale`, and a second authoritative omission drops it. (This is the one
  existing expectation S2 intentionally changes; note it in the commit message.)
- Keep: the server-line/ghost behaviour and the first-frame-authoritative tests in
  `sync/transcript.test.ts`.
- **New:** a reconnect's first frame that omits an unconfirmed client line does not blink it (fold
  level), and the same frame still clears a gone server line.

---

## 5. Step 4 — S5: the session pane's line carries the prepared message

**Sites:** `views/SessionView.tsx:845` and `:894` — both `queuedLineOf(admitted, caption, prepared?.images ?? [])`.
The chat thread builds its line from the prepared message (`views/chatThreadSession.tsx:723` via
`writeSend`'s wire text), which carries the file-attachment trailer.

**Change (two call sites, one argument):** pass `prepared?.message ?? caption`. Nothing else:
`isDeliveryOf` is already trailer-tolerant on both sides.

**Test (`SessionView.test.tsx`):** a queued send with a file attachment shows the full prepared text
(trailer included) in the panel line from the moment it appears — no caption-then-correction.

---

## 6. Step 5 — S6: the read-only composer shows no panel

**Site:** `views/SessionView.tsx:1915-1925` — the `ChatComposer` rendered while history is being read
(`readingHistory && vinculum && (!navHistory || !liveRpc)`), fed `queued={chat.queued}` and
`onRemoveQueued={removeQueued}`.

**Authority:** design `2-design-1/design.md:73` — "The session has ended, or it is a terminal
session, or history is being read. **There is no panel.**" So this is not a surface the plan's four
surfaces cover, and a working Remove button inside a read-only surface is wrong.

**Change:** drop `queued` and `onRemoveQueued` from that call site (both props are optional).
`removeQueued` stays — the live composer (`:1772`) uses it. The other three surfaces
(`ChatView.tsx:678`, `QuickChat.tsx:466`, `SessionView.tsx:1772`) keep the panel.

**Test (`SessionView.test.tsx`):** a live session with the history view open and something queued
renders no queued panel and no Remove button in the read-only composer.

---

## 7. Step 6 — S7: fold the frame shape a queue-only change really produces

**What the daemon really emits** for a queue-only change (`runtime/transcript.ts:97-101`):
`{ items: [], nextItem: <client's next index>, replace: false, queued: {...} }` — empty item list, no
replace, next index at the client's end. The app's fake daemon only ever sends full lists with
`replace: true` (`test/sessionDaemon.ts:91`), so no test has ever folded the real shape.

**Test (`sync/transcript.test.ts`, next to the existing queue tests):** over a **non-empty** list, fold
that exact shape and assert (1) `applyFrame` returns the list unchanged — no restart from 0, no
`needsReplay`, no duplicated or dropped rows — and (2) the queue from the frame is applied to the
panel state (`applyVinculumTranscript`: same messages, `queued` as sent, count follows). One test,
both halves.

---

## 8. Step 7 — S9: protocol 57 → **59** in this change

**Change (two literals, one commit, together with the wire sources as the report's attention note
demands):**
- `alinery-app/src-tauri/alinery-core/src/protocol.rs:16` — `pub const PROTOCOL_VERSION: u32 = 59;`
- `alinery-app/src-tauri/vinculum-daemon/src/main.ts:78` — `const PROTOCOL = 59;`

**Why 59:** `58` belongs to the unmerged, unbranched commit `9a99cb55` which also moves 57 → 58 and
touches the same daemon files. This change now takes 59, so both can land in any order with **no
re-bump** — whoever lands second does nothing. (Field numbers never collided; this was only ever a
merge-ordering problem, and the human resolved it by renumbering.) No `.proto`, generated file, or
golden carries the number — **no wire regeneration** is needed for the bump; the proto tests and the
fresh-regeneration check from the earlier rounds still stand for the feature's own wire changes.

**Pre-release checklist (not code, not a note — S3 is dropped):**
- Rebuild and reinstall the remote runtimes (`scripts/build-remote-runtimes.sh`, then ship the fresh
  archives to remote hosts): a host still carrying the old archive keeps an old-protocol daemon the
  new app refuses. This is the S9 half the comment did not address and the only remaining blast
  radius. Remember `alinery-app/src-tauri/resources/remote/*.tar.gz` are untracked — the artifacts
  live outside git.
- Stop live sessions and restart the local daemon before installing (routine for a protocol bump;
  documented elsewhere per the human's comment).

**Verification:** `git grep -n "PROTOCOL" ` shows the two constants move together; the Rust assertion
(`PROTOCOL_VERSION >= 39`) still holds; daemon/proto bun tests pass.

---

## 9. Verification and gates

Per step as you go, then the full gates at the end:

1. Targeted: `npx vitest run src/chatTranscript.test.ts src/chat/send.test.ts src/views/ChatView.test.tsx src/views/SessionView.test.tsx`
   (after step 1: all green, ~277 tests) and `src/sync/transcript.test.ts` after steps 3 and 6.
2. Full app suite: `cd alinery-app && npm run test` — **must be fully green**; the two red tests above
   are the repository's deciding gate blocker.
3. `npm run lint` and `npm run typecheck` (both tsconfig passes).
4. Daemon + proto: `bun test` in `alinery-app/src-tauri/vinculum-daemon` and `proto` (the one
   credential-capability daemon failure is environmental and pre-existing on the base commit).
5. Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
6. `scripts/check.sh` end to end. Two things it cannot do on this history: the version-bump gate is
   vacuous until the commit exists relative to its base — re-run it after committing; and the
   flake-skip list applies only with `--release`.
7. Not doable here: the ten person checks (the repository forbids launching the app) — they stay open
   for the human.

---

## 10. Risks and constraints

- **The two red tests are the gate.** Nothing is merge-callable until step 1 lands; do B1 first.
- **Round-3 pins:** the cue's successful-abort behaviour (`consumeQueueCue`, the `withdrew` filter,
  the coalesce-window tests) must not change. Step 1 only adds the rejection path's retraction.
- **The one intentional behaviour change** is S2's pending-line sparing; its pin test (`:799`) is
  rewritten deliberately, not accidentally.
- **No app launch, no README edits** (AGENTS.md), **no doc note** (S3 dropped), **no cache** (S4
  dropped and its conditional variant thereby never fires).
- **Nothing pushed.** The branch exists to protect the work; the human decides about a remote.
- The cue's render-phase ref writes (minor notes) are **not** touched — out of scope.