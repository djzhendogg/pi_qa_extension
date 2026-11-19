# Implementation ledger

Plan: docs/superpowers/plans/2026-11-19-qa-goal-guardian.md

- User authorized local Pi download and direct implementation in this checkout; no further design questions.
- Published Pi 1.5.2 installed locally; package-lock pins the complete development dependency tree.
- State tests first failed for absent module, then exercised immutable case parsing, verdict validation, reported-only trust and atomic report writes.
- Environment finding: redirected sandbox TEMP denies rename; a workspace rename probe succeeds. Tests use verified workspace-local temporary directories and clean them up.
- Runtime tests initially exposed Pi auth preflight even with a substituted stream. Test-only provider registration uses a deliberately fake fixture credential and an unreachable local URL; no real API key or external request is used.
- Stop decision: close gate synchronously in finish; preserve all sibling tool results; abort in turn_end. An abort at tool execute time would leave later sibling tool calls without tool results.
- Technical outcome decision: finalize missing finish at agent_settled rather than agent_end, because Pi may retry/compact after agent_end.
- Transport metrics count hook events and explicitly exclude internal retries; no inferred browser-success or repeat metrics.
- Task 1: six state tests and typecheck passed.
- Task 2: sixteen Pi integration tests plus six state tests and typecheck passed; actual disk entry point loading included.
- Independent code review found pre-prompt compaction occurring before before_agent_start and swallowed before_provider_request exceptions. Fixed with early input handling, session_before_compact cancellation, terminal cache-warming stop and signal cancellation instead of throwing.
- Review regression tests first failed (manual compaction proceeded; warming remained enabled), then passed. Full suite: 25/25; typecheck passed. Retry recovery test also passed with Pi retry enabled.
- CLI smoke: local Pi reports 1.5.2; actual CLI loads extension and lists --qa-case / --qa-results-dir. Smoke config isolated with PI_CODING_AGENT_DIR inside workspace because sandbox disallows writes to the user's global ~/.pi directory.
- Test harness waits for actual agent_settled after /qa-run because pi.sendUserMessage schedules asynchronously; waiting only for current isIdle races input processing. Test credentials/catalog are now in memory to prevent background fixture disk writes.
- Review boundaries retained: no nested concurrent finish guarantee, no independent evidence verifier, preflight authentication setup remains recoverable without invented verdict, actual target Browse/Ascend validation remains outstanding.
- Real Ascend/Browse execution remains for target environment.

## Progress checkpoints and context regression

- User observed repetitive reorientation between browser tool calls and asked for current progress in context.
- Regression confirmed in constructed request shape: old context hook appended a new user-role full-task reminder after each browser result. This is a plausible model-behavior trigger, not a reproduced inference outcome on Ascend.
- Removed that trailing user anchor and recurring uncertainty/recheck instructions. Original task and short workflow rules now use stable before_agent_start structured system sections.
- Added bounded, agent_reported qa_checkpoint snapshots with completed work, current_objective and optional observation. Latest snapshot persists in the report (running status) and a named leading system section; it survives automatic compaction without claiming verified progress.
- Runtime detail discovered by integration test: returning a forced systemPrompt causes Pi to overwrite context_with_system sections after hooks. The adapter now mutates systemPromptOptions.sections instead. External extensions that force the prompt remain an unsupported combination documented in README.
- State and integration regressions failed before implementation, then all 34 tests and typecheck passed. New coverage includes prompt placement, updated objectives, compaction, terminal/storage guards, malformed snapshots and reset between runs.
- Runtime guarantees are tested; improvement of actual Qwen/DeepSeek behavior remains a target-environment A/B question.
- Independent review found no blocking issue in the progress changes; final typecheck and all 34 tests passed. Changes remain local pending a new push request.
- User requested limiting routine rechecks to the last action/current objective. Updated the stable QA rules to reuse the last tool result, skip redundant verification calls when it suffices, and revisit only a specific earlier step implicated by a concrete failure/state contradiction or explicit test-case requirement. Final expected-result assessment remains required; no Browse-call classifier or new tool calls were added.

## Human-only diagnostic screenshots

- User directed us to take the screenshot API from Browse. No Browse tool is connected in this Codex session and no local Pi MCP configuration exists. Read official anomalyco/browse dev source screenshot.rs and README instead of asking user for a schema.
- Adapter discovers the live plain screenshot tool (suffix screenshot, required tab), tracks the last successful same-namespace tab, then makes one nested call after checkpoint persistence: {tab, format: png}. No fallback browser controller, tab listing, proxy edits or screenshot LLM call.
- tool_result hook writes inline image bytes to a separate qa-diagnostics/run UUID folder, strips screenshot content/metadata and prevents visual input to the nonvisual model. Context filtering also removes historical image blocks. No screenshot artifacts/paths enter QaRun reports.
- Failed captures/writes remain nonfatal and separate from QA verdict. No retries. A 10-second abort signal is passed; backend cancellation is cooperative.
- Tests first failed for missing screenshot capture, then passed through actual Pi nested execution, including duplicate metadata filtering, successful file writes, unknown target, invalid checkpoint, backend failure and unwritable diagnostic directory. Real Browser/Ascend remains target validation.
- Independent screenshot review found no material issue with newly captured Browse screenshots. Addressed its historical inline-media hardening suggestion by sanitizing compaction preparation text as well as main context; regression failed before the string-content filter and passed after it. Textual DOM image descriptions without pixels remain intact.
