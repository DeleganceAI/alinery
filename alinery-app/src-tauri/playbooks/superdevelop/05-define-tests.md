# Define Tests

Establish how the approved behavior will be tested before implementing it. Produce a test contract and, where feasible within the task, real failing tests that the Build stage can use.

### Work

1. Read the approved design and implementation plan. Inspect existing tests, fixtures, and the repository's test commands before choosing a test location or adding machinery.
2. Map each changed behavior to the smallest meaningful test. State which incorrect production behavior would make that test fail. Cover relevant boundaries and failure cases without mirroring internal implementation details.
3. Prefer behavior through real public interfaces. Use mocks only where an external boundary genuinely requires them, and test the application's behavior rather than the mock configuration.
4. Establish the relevant baseline. Record pre-existing failures separately so they cannot later be mistaken for evidence of the new behavior.
5. Write and run the first useful regression or feature tests when this can be done without implementing the feature. Confirm that failures are caused by the intended missing behavior. A broken fixture, bad import, or environment failure is not that evidence. If the planned API does not exist yet, record that limitation precisely.
6. Do not build production scaffolding merely to finish this stage. For cases that cannot yet run, specify the exact test, prerequisite, command, and expected failure. Mark them as specified but not demonstrated; the Build stage must establish their red result before treating them as a tested change.
7. For a change where executable tests would not establish correctness, explain why and define the concrete alternative check. Follow explicit repository or user requirements for exceptions; do not claim that an unrun test passed.

### Deliverable

Write a test contract containing:

- Behavior-to-test mapping, with exact test paths or case names.
- Baseline commands and observations.
- Tests actually added and the observed reason for each failure.
- Planned tests not yet runnable, their prerequisites, and the next action needed to demonstrate red.
- Required commands and acceptance observations for Build.

### Ready when

The contract covers the approved behavior and clearly distinguishes demonstrated red tests, deferred test execution, pre-existing failures, and alternative checks. Expected feature-test failures are a valid handoff to Build; they are not a passing test suite. Unexplained setup failures remain blockers. Do not implement the feature here or delete existing production code to manufacture a failure.
