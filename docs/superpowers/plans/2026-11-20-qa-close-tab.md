# Close QA tab implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Attempt to close the known QA tab once on every run outcome, without model calls or verdict changes.

**Architecture:** A per-run cleanup object observes successful Browse results, selects a unique plain close tool with required tab, and admits only its pending internal call. Terminal QA tools await cleanup after diagnostics; settlement/shutdown use the last QA tool context with a fresh signal when necessary.

**Tech Stack:** TypeScript, Pi 1.5.2, node:test.

**Spec:** User approved automatic close after any passed/failed/blocked or technical incomplete/error/abort. Final checkpoint screenshot precedes closure. Hard process kill cannot run cleanup.

> Исправление контракта Browse: первоначальный поиск close/close_tab/tab_close оказался несовместим с реальным MCP. Текущая реализация использует tabs({action: "close", tab}) по rust/crates/browse-relay/src/tools.rs. Общая схема tabs имеет required: []; tab обязателен при выполнении close. Указания ниже о plain close-tool заменены этим контрактом.

## Global Constraints

- Do not close arbitrary tabs or the browser; no tab enumeration or broad session cleanup.
- Preserve QA verdict on close error. Exactly one attempt, independent of the cancelled model signal.
- No extra LLM call. Terminal gate remains closed to model calls, including model-issued close calls.
- Use the existing checkout; no commit/push requested for this change.

## Review Focus

- Unknown tab or absent/ambiguous compatible close tool must skip safely.
- Failed and foreign namespace results must not replace the QA tab.
- Cleanup after abort needs a fresh signal and must not rerun submission or capture.
- Reload/shutdown and settlement must not duplicate cleanup or use another run's tab.
- Internal close permission expires immediately after its single invocation.

### Task 1: Cleanup and tests

**Files:** src/qa-tab-cleanup.ts (new), shared tab helpers in src/qa-diagnostics.ts, test/qa-tab-cleanup.test.ts (new).
**Interfaces:** QaTabCleanup.observe(event, tools), close(parentId, ctx), allowsClose(event).

- [x] Write tests for target selection, namespace isolation, single attempt, failure, cancellation signal and narrow authorization; observe RED.
- [x] Implement per-run cleanup and reuse tab parsing; run tests GREEN.

### Task 2: Pi lifecycle integration

**Files:** src/qa-extension.ts, test/qa-extension.test.ts, README.md.
**Interfaces:** Last QA ExtensionToolContext retained per run; pending cleanup admission checked before terminal gate.

- [x] Add real Pi tests for passed/failed/blocked, screenshot ordering, abort/incomplete/error, close errors, terminal sibling denial and successive runs; observe RED.
- [x] Wire terminal tools and fallback settlement/shutdown cleanup; preserve report outcome on cleanup failure.
- [x] Update README requirements and limits; run full tests and typecheck; review diff.

## Ledger

- User explicitly authorized implementation of the agreed behavior; no further design confirmation needed.
- Runtime discovery uses tab-scoped close/close_tab/tab_close tools only, with no other required arguments. Broad cleanup and arbitrary execute scripts are excluded.

- Task 1 complete: cleanup tests RED→GREEN, independent target tracking, one-shot origin admission and fresh signal.
- Task 2 complete: real Pi tests RED→GREEN for terminal verdicts, technical settlement, user abort, checkpoint abort, shutdown, report storage error and repeated runs.
- Final review: read-only reviewer identified close response tab metadata ambiguity. Fixed using requested input.tab; both own-tab/foreign-tab regressions observed RED→GREEN. Added real Pi close-only catalog coverage to resolve test gap.
- External validation limits: live Browse schemas and backends that ignore abort signals remain target checks. No commit/push in this implementation request.

- Bugfix: cleanup unit and Pi integration fixtures migrated from invented plain close tool to the real tabs action schema. Tests observed RED before production fix, then GREEN; authorization checks exact action+tab and rejects other tab operations. tabs new can establish the target; tabs list never selects a QA tab.

- Review regression fixed: tabs(list/default) is ignored by both screenshot and cleanup target tracking; otherwise a diagnostic screenshot could indirectly select a foreign cleanup tab. Three diagnostic regression tests observed RED→GREEN, plus a real Pi list→checkpoint→finish test verifies both calls retain the QA tab. Live Browse proxy execution remains unverified.

- Final validation of tabs contract fix: full suite 85/85 with node --import tsx --test --test-concurrency=1 test/*.test.ts; typecheck green. Default concurrent-file runs hit the pre-existing Windows EPERM atomic-report-rename issue (including qa_finish in the recovery test); no storage behavior changed in this fix.
