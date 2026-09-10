# Plan

Convert the approved design into an implementation plan that another Session can execute without reconstructing the reasoning or guessing the intended interfaces.

### Work

1. Read the approved design and its referenced evidence. Verify which version is approved. Resolve missing approval or a material contradiction before planning implementation.
2. Check the current repository against the design. If new evidence changes the agreed solution, surface that change instead of burying a redesign in the plan.
3. Identify the files and existing interfaces the work actually touches. Give each change one clear owner. Keep unrelated refactoring outside the plan.
4. Divide work into independently verifiable deliverables. Fold setup into the deliverable that needs it. Split where a reviewer could meaningfully accept one result and reject another, not merely at arbitrary file or line counts.
5. For each deliverable, specify its purpose, exact paths, required inputs, resulting interface or behavior, ordered actions, tests, verification commands, and expected observations. Include precise signatures or examples when ambiguity would otherwise force invention. Do not prewrite an entire implementation merely to make the plan long.
6. Make test-first execution explicit. The Define Tests stage will establish the test contract; the Build stage must still demonstrate red and green as it develops each behavior.
7. Review the plan against every acceptance condition. Check references and interfaces across tasks. Replace vague instructions such as “handle edge cases” with the actual cases that matter.

### Deliverable

Write a plan containing:

- Goal, approved design path, and project-wide constraints.
- Ordered deliverables with concrete changes and verification for each.
- Interfaces and dependencies between deliverables.
- Acceptance-condition-to-verification mapping.
- Known risks and explicit stop conditions.

### Ready when

Every acceptance condition has an executable path to implementation and verification, references resolve, and no material design decision has been delegated to guesswork. Do not edit production code or tests in this stage. Keep the plan in the assigned artifact rather than adding a second plan under a hardcoded repository path.
