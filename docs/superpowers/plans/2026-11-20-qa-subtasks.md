# QA subtasks implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Execute a fixed plan in Pi with a checkpoint and diagnostic attempt per subtask.

**Architecture:** QaRun owns validated scenario, plan and state transitions. The extension gates tools by the current stage and delegates screenshots to QaDiagnostics. Pi retains the single model loop.

**Tech Stack:** TypeScript, Pi 1.5.2, node:test.

**Spec:** ../specs/2026-11-20-qa-subtasks-design.md

## Global Constraints

- No expected field, nested LLM calls, replanning or image input to the model.
- Explicit task granularity; blocked only for persistent concrete obstacles after safe recovery where possible.
- Fixed sequential IDs; checkpoint persisted before diagnostics; storage errors close the gate.
- Work in the existing checkout as instructed by the host; no automatic commits.

## Review Focus

- Invalid inline JSON must never become a filename; conflicting startup sources fail closed.
- Model screenshot calls cannot impersonate internal checkpoint diagnostics.
- Abort during diagnostics preserves an accepted failed/blocked result.
- Invalid transitions and duplicate checkpoints must preserve the last accepted state.
- Side effects with unknown outcomes must not be repeated by the recovery instruction.

### Task 1: State and scenario schema

**Files:** src/qa-state.ts; test/qa-state.test.ts.
**Interfaces:** parseTestCase(input), QaRun.plan(input), executeSubtask(input), checkpoint(input), completeCheckpoint(), allowsTool(name), finish(input), progressContext(), report().

- [x] Replace state tests with scenario validation, immutable plan, sequential activation, checkpoint barrier, aggregate finish, duplicate rejection, abort and storage failure tests; run and observe failures.
- [x] Implement schema v2 and transitions, bounded inputs and compact dynamic context.
- [x] Run state tests; expected all passing.

### Task 2: Pi integration and diagnostic origin

**Files:** src/qa-extension.ts; src/qa-diagnostics.ts; test/qa-extension.test.ts; test/qa-diagnostics.test.ts.
**Interfaces:** Task 1 state API; QaDiagnostics authorizes only a pending internal capture by its parent call ID and tool name.

- [x] Add integration tests for JSON/file startup, conflicts, gates in mixed packets, diagnostics, abort, compaction, retries and terminal behavior; observe failures.
- [x] Register plan/execute tools, replace checkpoint contract, gate every call, complete checkpoint after diagnostic attempt and preserve accepted result on settlement.
- [x] Add concise decomposition and rare-blocked instructions; keep tool responses compact.
- [x] Run integration and full suite; expected all passing.

### Task 3: Usage and verification

**Files:** README.md; test-case.json; design status.

- [x] Update examples, migration notes, result semantics and limits.
- [x] Run npm test and npm run typecheck; expected exit 0.
- [x] Review whole change in fresh context; fix material findings with regression tests.

## Execution ledger

- User explicitly requested implementation of the linked design. Initial decomposition instruction uses its agreed examples; real-model tuning remains separate.
- Preserve current checkout and leave changes uncommitted, following host workspace preference.

- Task 1: complete — state/schema tests RED→GREEN; immutable sequential lifecycle and schema v2 implemented.
- Task 2: complete — real Pi integration tests RED→GREEN, including internal screenshot admission, mixed batches, compaction and capture abort.
- Task 3: complete — README/sample migrated. Fresh read-only reviewer found no Critical/Important issues. Terminal response finding fixed with a failing regression test, then suite 48/48.
- Validation detail: full HTTP(S) URL syntax tightened after regression tests for https:example.com and http:/example.com failed.
- Review limits: real quantized-model quality, real Browse integration, observation truth and backends ignoring abort signals require target validation; these are documented limits, not inferred guarantees.
