# Automatic QA subtask activation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Remove activation tool round-trips while preserving the execution gate.
**Architecture:** QaRun activates S1 when accepting a plan and activates each next task only after checkpoint diagnostics complete. Pi exposes qa_plan, qa_checkpoint and qa_finish; qa_execute_subtask and ready stage are removed.
**Tech Stack:** TypeScript, Pi 1.5.2, node:test.
**Spec:** User approved the proposed automatic activation flow in this chat. Final qa_finish remains explicit.

## Global Constraints

- No new LLM calls or replanning. Current task ID is stored in extension.
- During checkpoint persistence/diagnostics browser actions stay blocked.
- Failed/blocked, abort and storage errors do not activate the next subtask.
- Standalone screenshots remain blocked; terminal tab cleanup remains intact.
- Existing checkout; no commit or push requested.

## Review Focus

- Duplicate/wrong checkpoint ID cannot finish the newly activated task.
- Slow screenshot must keep next actions gated.
- Abort during successful checkpoint must not expose the next task.
- Error while persisting the transition must close the gate.
- Model receives next task/description in tool response and after compaction, without an activation tool.

### Task 1: State transitions

**Files:** src/qa-state.ts, test/qa-state.test.ts.
**Interfaces:** plan() activates S1; completeCheckpoint() activates next task or awaiting_finish; private activation helper owns active ID/stage. Remove executeSubtask().

- [x] Adapt tests and observe RED for automatic activation, ordered checkpoints and no ready stage.
- [x] Implement transitions and compact next-action context; run state tests GREEN.

### Task 2: Pi tools and documentation

**Files:** src/qa-extension.ts, test/qa-extension.test.ts, README.md.

- [x] Adapt integration tests to remove activation calls; add response/compaction/capture barrier/abort tests and observe RED.
- [x] Remove qa_execute_subtask registration, update rules and return next task after capture. Abort during capture ends the run before next activation.
- [x] Update README lifecycle and required tools. Run full suite/typecheck and fresh read-only review.

## Ledger

- Task 1 complete: automatic activation tests RED→GREEN; active ID/stage stored in QaRun; checkpoint ordering and persistence gate verified.
- Task 2 complete: activation tool removed from Pi catalog and prompts. Real Pi tests cover returned S1/S2, three-request scenario without activation calls, compaction, capture barrier and passed-capture cancellation.
- Fresh read-only review: no Critical/Important findings. Initial design annotated as superseded for activation/ready semantics to resolve documentation drift.
- Final validation: 77 tests and typecheck pass. An initial run hit the previously observed Windows EPERM on atomic report rename; separate repeat passed, no unrelated storage behavior changed.
- Real-model quality and live Browse behavior remain external validation limits. Changes left uncommitted.
