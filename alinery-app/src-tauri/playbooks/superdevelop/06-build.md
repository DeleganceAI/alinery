# Build

Implement the approved plan through small verified changes. Keep the design, tests, and actual behavior aligned, and leave evidence that another Session can check.

### Work

1. Read the approved design, plan, and test contract. Inspect the current diff and relevant code. Resolve material contradictions before modifying the implementation.
2. Work through the planned deliverables in dependency order. Use the existing interfaces and tools identified by the plan. Update the plan only for changes within the approved design; ask the user when the design or scope must change.
3. For each changed behavior, add or identify its test and run it before implementing the behavior. Confirm the intended failure. If the test already passes, determine whether the requirement is already met or the test misses it; do not change code merely to force a red result.
4. Write the smallest production change that satisfies that test. Run it again and inspect the result. Fix the implementation when it fails; change a test expectation only when evidence shows the test contradicted the approved requirement.
5. Refactor only after green, keeping the behavior covered. Re-run the relevant tests after the refactor. Continue the red/green/refactor cycle for subsequent behavior, including tests that the Define Tests stage could only specify.
6. Inspect the completed diff against the plan and acceptance conditions. Check affected callers, error paths, scope boundaries, and unintended changes. If an independent reviewer is available and authorized, give them the requirements and exact diff; otherwise label your review as self-review.
7. Run the repository-required checks and checks appropriate to the final changes. Read the actual output and exit status. Record command, relevant result, and the source state tested; earlier output does not prove a later edit is correct.
8. If blocked, keep the working tree and partial evidence intact. Report the exact failure and needed decision or prerequisite. Do not relax checks, discard unrelated work, or call the stage complete to advance past a blocker.

### Deliverable

Write an implementation report containing:

- What changed and how it satisfies the approved outcome.
- Completed deliverables and any justified deviations.
- Test-first evidence for the changed behavior, including cases initially deferred.
- Final verification commands and literal results, with failures and unverified claims identified separately.
- Review findings and their resolution; identify self-review versus independent review accurately.
- Remaining risks and the exact code state or diff to inspect during PR preparation.

### Ready when

The scoped implementation is complete, required checks pass, and review findings that block correctness are resolved. Any explicitly accepted exception must be documented with its actual authorization and limitation. Do not claim readiness from a test plan, a partial compile, or a previous Session's success message. Prepare the handoff without publishing, merging, or deleting the workspace.
