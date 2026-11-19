# QA Goal Guardian Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Execute inline; user explicitly requested code without further questions.

**Goal:** A working MVP 1 Pi extension with an explicit terminal gate and honest JSON results.
**Architecture:** Thin Pi adapter over a standalone execution state/report module. Use the installed Pi session for deterministic integration tests, replacing only the external LLM stream.
**Tech Stack:** TypeScript, Node >=22.19, Pi 1.5.2, TypeBox, Node test runner.
**Spec:** docs/superpowers/specs/2026-11-19-qa-goal-guardian-design.md

## Global Constraints

- Pi owns the loop; Browse owns browser operations.
- No checkpoint, watchdog, independent evidence verifier or proxy modifications in MVP.
- Reported verdict is never a verified verdict.
- Develop in the current checkout as requested; no unsolicited commits or publishing.

## Review Focus

- Mixed finish/browser batches must not execute tools after the terminal decision.
- Persistence failures must leave the gate closed and expose an error.
- Session replacement and repeated runs must not leak state.
- Invalid case/finish inputs must not silently terminate a valid run.
- Aborts and normal completion without finish must produce technical outcomes.

## Task 1: Execution state and reports

Files: src/qa-state.ts, test/qa-state.test.ts, package.json, tsconfig.json.
Interface: parseTestCase(input: unknown): TestCase; QaRun stores immutable case, builds anchor, accepts finish and writes report.

- [x] Write tests for immutable validated input, reported-only verdict, unique report paths, idempotent finish and persistence failure.
- [x] Run the tests and observe failures before implementation.
- [x] Implement state, strict validation and atomic unique JSON reports.
- [x] Run state tests and typecheck.

## Task 2: Pi adapter and runtime integration

Files: .pi/extensions/qa.ts, src/qa-extension.ts, test/qa-extension.test.ts.
Interface: default ExtensionAPI factory, /qa-run, --qa-case, qa_finish.

- [x] Inspect installed API, loop and session event ordering.
- [x] Write integration tests with real Pi sessions and deterministic stream for single/mixed finish, invalid finish, interrupted run, tool failure and repeated runs.
- [x] Observe failures, implement hooks/gate, preserve tool-result history and stop before another model request.
- [x] Verify actual extension loading, all runtime tests and typecheck.

## Task 3: Delivery and review

Files: README.md, test-case.json, .gitignore, docs/implementation-notes.md.

- [x] Document install, supported Pi version, interactive/print invocations, report schema and honest limitations.
- [x] Run full test suite and typecheck; fresh reviewer reads code and tests.
- [x] Fix material findings with regression tests; report exact validation and remaining integration limits.
