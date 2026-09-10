// Bundled prompt sources and SuperDevelop common instructions.

pub const DEFAULT_PLAYBOOK_PROMPTS: &[(&str, &str)] = &[
    (
        "playbooks/superdevelop/01-clarify.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/01-clarify.md")
        ),
    ),
    (
        "playbooks/superdevelop/02-investigate.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/02-investigate.md")
        ),
    ),
    (
        "playbooks/superdevelop/03-decide.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/03-decide.md")
        ),
    ),
    (
        "playbooks/superdevelop/04-plan.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/04-plan.md")
        ),
    ),
    (
        "playbooks/superdevelop/05-define-tests.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/05-define-tests.md")
        ),
    ),
    (
        "playbooks/superdevelop/06-build.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/06-build.md")
        ),
    ),
    (
        "playbooks/superdevelop/07-prepare-review.md",
        concat!(
            include_str!("../../playbooks/superdevelop/common-session.md"),
            "\n\n",
            include_str!("../../playbooks/superdevelop/07-prepare-review.md")
        ),
    ),
    ("playbooks/one-shot/01-implementation.md", include_str!("../../playbooks/one-shot/01-implementation.md")),
    ("playbooks/one-shot/02-pr.md", include_str!("../../playbooks/one-shot/02-pr.md")),
    ("playbooks/review/01-review-context.md", include_str!("../../playbooks/review/01-review-context.md")),
    ("playbooks/review/02-review-checks.md", include_str!("../../playbooks/review/02-review-checks.md")),
    ("playbooks/review/03-review-findings.md", include_str!("../../playbooks/review/03-review-findings.md")),
    ("playbooks/review/04-review-response.md", include_str!("../../playbooks/review/04-review-response.md")),
    ("playbooks/bug-hunting/01-rca.md", include_str!("../../playbooks/bug-hunting/01-rca.md")),
    ("playbooks/bug-hunting/02-solutions.md", include_str!("../../playbooks/bug-hunting/02-solutions.md")),
    ("playbooks/bug-hunting/03-design.md", include_str!("../../playbooks/bug-hunting/03-design.md")),
    (
        "playbooks/bug-hunting/04-implementation.md",
        include_str!("../../playbooks/bug-hunting/04-implementation.md"),
    ),
    ("playbooks/bug-hunting/05-pr.md", include_str!("../../playbooks/bug-hunting/05-pr.md")),
];
pub(crate) const DEFAULT_PLAYBOOK_NOTICES: &[(&str, &str)] = &[
    (
        "playbooks/superdevelop/LICENSE.superpowers",
        include_str!("../../playbooks/superdevelop/LICENSE.superpowers"),
    ),
    ("playbooks/superdevelop/README.md", include_str!("../../playbooks/superdevelop/README.md")),
];
pub(crate) const SUBTASK_MANAGER_PROMPT: &str = include_str!("../../../prompts/subtask-manager.md");
pub(crate) const SUBTASK_MANAGER_RECOVERY_PROMPT: &str = include_str!("../../../prompts/subtask-manager-recovery.md");

// Internal step keys and the user-visible stage names.
pub const PHASES: &[(&str, &str, &str)] = &[
    ("research-questions", "Clarify", DEFAULT_PLAYBOOK_PROMPTS[0].1),
    ("research", "Investigate", DEFAULT_PLAYBOOK_PROMPTS[1].1),
    ("design", "Decide", DEFAULT_PLAYBOOK_PROMPTS[2].1),
    ("structure", "Plan", DEFAULT_PLAYBOOK_PROMPTS[3].1),
    ("tdd", "Define Tests", DEFAULT_PLAYBOOK_PROMPTS[4].1),
    ("implementation", "Build", DEFAULT_PLAYBOOK_PROMPTS[5].1),
    ("pr", "Prepare Review", DEFAULT_PLAYBOOK_PROMPTS[6].1),
];
pub fn phase_prompt(key: &str) -> Option<&'static str> {
    PHASES.iter().find(|(k, _, _)| *k == key).map(|(_, _, prompt)| *prompt)
}
