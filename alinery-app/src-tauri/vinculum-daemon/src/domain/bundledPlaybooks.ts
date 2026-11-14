// The playbooks that ship with the app (plan S4.6), embedded in the daemon the way `config.default.toml` is. The order is the
// order of alinery-core `BUNDLED_PLAYBOOKS`; `playbookLibrary.test.ts` checks the keys against the `playbooks/` directory.
import p0 from "../../../playbooks/superdevelop/playbook.md" with { type: "text" };
import p1 from "../../../playbooks/one-shot/playbook.md" with { type: "text" };
import p2 from "../../../playbooks/review/playbook.md" with { type: "text" };
import p3 from "../../../playbooks/bug-hunting/playbook.md" with { type: "text" };
import p4 from "../../../playbooks/free-form/playbook.md" with { type: "text" };
import p5 from "../../../playbooks/generic-session/playbook.md" with { type: "text" };
import p6 from "../../../playbooks/natural-planning-brainstorm/playbook.md" with { type: "text" };
import p7 from "../../../playbooks/systematic-naming/playbook.md" with { type: "text" };
import p8 from "../../../playbooks/primed-feature-development/playbook.md" with { type: "text" };
import p9 from "../../../playbooks/systematic-evidence-review/playbook.md" with { type: "text" };
import p10 from "../../../playbooks/build-playbook/playbook.md" with { type: "text" };
import p11 from "../../../playbooks/academic-survey/playbook.md" with { type: "text" };
import p12 from "../../../playbooks/spec/playbook.md" with { type: "text" };
import p13 from "../../../playbooks/solution-exploration/playbook.md" with { type: "text" };

export const BUNDLED_PLAYBOOKS: readonly (readonly [string, string])[] = [
  ["superdevelop", p0],
  ["one-shot", p1],
  ["review", p2],
  ["bug-hunting", p3],
  ["free-form", p4],
  ["generic-session", p5],
  ["natural-planning-brainstorm", p6],
  ["systematic-naming", p7],
  ["primed-feature-development", p8],
  ["systematic-evidence-review", p9],
  ["build-playbook", p10],
  ["academic-survey", p11],
  ["spec", p12],
  ["solution-exploration", p13],
];
