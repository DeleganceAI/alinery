# Playbook step strip — flat treatments

Design riff for the mini step strip on playbook cards (onboarding archetype cards,
and anywhere else `onboarding-mini-chain` ends up). Open `mockup.html` in a browser
to see the four variants on the app's dark tokens; `mockup.png` is the same thing
rendered.

## The constraint

The strip stays **one horizontal row**. No lanes, no drawn branches. When a step
actually fans out into several agents, the strip still has to say so, but inside
the row.

## Every glyph is already in the step definition

Nothing new needs to be modelled. Each symbol from the "How work moves" legend
falls out of `NormalizedStep` as it exists today:

| Glyph | Derived from | Meaning |
|---|---|---|
| arrow (default) | `auto_advance_default = true` | moves on when the output validates |
| hand | `auto_advance_default = false` | pauses for you; drawn **after** the step, since that is where the pause is. The last step gets a trailing hand. |
| fan-out into a stacked node | any input with `mode = "each"` | the step runs once per matching file, one agent each |
| fan-in | any input with `mode = "complete"` | the step waits for the whole collection |
| loop-back | an output path that an earlier step takes as input | Natural Planning Brainstorm step 8 writes `ticket.md`, which step 1 reads |

Natural Planning Brainstorm exercises all five: fan-out at 2 and 4, fan-in at 3
and 5, checkpoints at 7 and 8, and a loop-back from 8 to 1. Academic Survey has
the same fan-out shape but every step auto-advances. SuperDevelop only has
checkpoints (3 and 7).

## Variants

- **A. The connector is the symbol.** Circles stay plain numbers. The gap between
  them carries the arrow, the hand, the three-strand fan-out or fan-in, or the
  loop-back. The `each` step is drawn as a stacked circle (a deck of cards).
  The branch lives entirely inside the 24px gap, so the row never grows a second
  lane. Recommended.
- **B. Symbol on the node, plain connectors.** Stacked circle for `each`, a hand
  badge for checkpoints. Fan-in and loop-back are only in the hover title. Quieter,
  but it hides "waits for all", which is the thing a user most needs to know when
  a playbook looks stalled.
- **C. Plain strip plus captions.** Today's strip untouched; a thin bracket under
  the parallel span says "×n, then join" in words. The most literal way to "let
  the user know there is branching" if the strand glyphs read as noise at 20px.
- **D. Variant A on SuperDevelop.** Checks that the vocabulary works on a
  playbook with no parallelism.

Amber on checkpoint nodes stays, but no longer carries the meaning alone, which
also fixes the colour-only read.

## Cost of A vs today

Today's connector is an 8px line with 3px margins (14px per gap). Glyph
connectors need about 24px. For an 8-step playbook the strip goes from roughly
258px to 328px wide, which still fits the card.

## Open questions for design

1. Is the three-strand fan-out legible at 24×20, or does it need the stacked
   node to carry the meaning on its own (variant B)?
2. Hand after the step vs hand on the node: A puts it in the gap, B on the node.
   Which reads as "pauses here"?
3. Loop-back: `↺ 2` in the gap after the last step, or drop it and rely on the
   hover title?
4. Do we keep a legend under the card list at all, or move every phrase into
   the hover title, where "waits for you" already lives?
