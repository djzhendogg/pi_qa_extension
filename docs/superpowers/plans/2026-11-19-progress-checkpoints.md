# Progress checkpoints and prompt regression fix

User requested progress in model context after reporting repeated reorientation between browser calls. Implement inline without another design gate, per the user's earlier instruction to write code directly.

Goal: expose the last reported completed work and current objective, without adding a fresh user message after every tool result.

Decisions:

- Original case and short workflow rules live in stable system prompt content.
- Remove the trailing user-role Goal Anchor and recurring statements that no progress is verified.
- qa_checkpoint accepts a compact snapshot: completed, current_objective, optional observation.
- Checkpoints are agent_reported, never verified. A checkpoint does not finish a case.
- Keep the latest snapshot in memory and JSON report. The model receives a named section of the leading system message via Pi 1.5.2 context_with_system.
- Update the progress section when checkpoint data changes; preserve tool declarations and browser results.
- No additional LLM, forced step decomposition or watchdog. Progress survives compaction; automatic process-restart recovery remains outside scope.

Tasks:

- [x] Regression tests fail against the trailing user anchor.
- [x] State tests fail for missing checkpoints; validate bounded, reported-only updates.
- [x] Implement stable case prompt and checkpoint tool, preserving finish/storage gates.
- [x] Test changing checkpoints, stable state between updates, compaction, repeated runs and terminal blocking.
- [x] Update docs, review changes and run full tests/typecheck. Actual model behavior needs target A/B testing.
