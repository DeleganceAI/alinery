# Playbook onboarding — the ring pane

Design proposal for the right pane of the playbooks onboarding step. It replaces
the pan-and-zoom canvas with a layout that fits the pane at any step count, with
no scrolling or panning. Open `mockup.html` in a browser; it is data-driven from
the bundled playbook files, so click between the three cards and hover the
steps. The PNGs are renders of it at 1040×680.

## What the pane shows, and what it drops

Shows: the real structure of the playbook, where it pauses for a human, where it
fans out into parallel agents, and the fact that most playbooks are loops. Hover
a step and its prompt's opening lines, mode, and reads/writes appear in the
centre of the ring. Nothing moves and nothing scrolls.

Drops: the canvas, the reads/writes contract grid, the full prompt text, and
the per-step inspector. The demo survives as a highlight walking the ring.

## Why a ring

A playbook is not a tree, so tree layouts (tidy trees, icicles, sunbursts) do
not apply. Layered layouts (what the current canvas does) compute their width
as an output, so a long playbook needs panning by construction. The layouts
that fit any pane by construction are the ones where position is a closed-form
function of index and pane size: arc diagrams, radial rings, matrices. The
matrix is out because the largest bundled playbook has about 35 artifacts.

The ring wins over the arc diagram because its shape is also the message. Every
bundled playbook that matters ends by writing `ticket.md` back to an earlier
step, and the canvas never showed that. On the ring the loop is the segment
that closes the circle. SuperDevelop has no loop, so its ring stays open.

## It is implemented

`alinery-app/src/PlaybookRing.tsx` is the component, used by the playbooks step
of `OnboardingFlow.tsx` in place of the canvas. `in-app-*.png` are renders of
that component with the app's own stylesheet. The edge classification lives in
`classifyRingEdges` and has a unit test beside the source. Geometry is in
viewBox units at the top of the file; the ring radius, label offset, and rail
spacing are the knobs to turn.

## Drawing rules

Edges come straight from the step contracts, by the same selector-overlap rule
`PlaybookGraph.tsx` already uses. Then:

| Thing | Drawn as |
|---|---|
| step i → step i+1 | the ring itself |
| a jump read by one later step | a chord, accent colour |
| an artifact read by two or more later non-adjacent steps | a dashed inner rail from the producer to its last consumer, with a tick at every consumer. `review-brief.md`, `clarify.md` and friends would otherwise be five chords each. |
| loop back to step 1 | the closing segment, dashed, success colour |
| loop back to any other step | a dashed chord, and the ring stays open |
| `auto_advance_default = false` | amber node plus a hand badge on the segment after it. The last step with no loop gets its hand just past the node. |
| an input with `mode = "each"` | stacked node, and the segment into it splits into three strands |
| an input with `mode = "complete"` | the three strands merge back into one |

Hovering a step dims every chord and rail that does not touch it.

## Limits

Titles fit around the ring up to about twelve steps. Past that the ring still
fits (Systematic Evidence Review has 29 steps) but titles live only in the
hover, and parallel A/B lanes share one position. SuperDevelop's five context
rails are the busiest case among the starters; whether nested rails read as
"context accumulates" or as clutter is the first thing to check with design.

## Open questions for design

1. Nested rails on SuperDevelop: keep, collapse to one rail, or hover-only?
2. The hand badge sits on the segment after a checkpoint. Would a hand on the
   node itself read better?
3. The demo currently walks the ring on a timer. Is that worth keeping, or
   does hover alone carry onboarding?
4. The centre block is 270px wide and clamps the prompt to three lines. Enough?
