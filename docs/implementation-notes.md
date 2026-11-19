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
