# Human-only Browse screenshots

User requested screenshots at meaningful checkpoints, excluded from model input and QA reports. User explicitly directed us to use Browse tools rather than ask them for the schema.

Sources inspected: official anomalyco/browse dev README and rust/crates/browse-capture/src/screenshot.rs. Screenshot accepts required tab, optional format/fullPage/path; inline response is an MCP image. No Browse MCP connection exists in this Codex session, so use Pi's live tool catalog at runtime.

- Discover one Browse screenshot tool by its name and runtime tab schema; skip ambiguous/unsupported catalogs rather than invent an API.
- Track tab from successful same-namespace Browse input/output, including execute's protocol tab header. No extra tab-discovery browser calls and no model decision to capture.
- After a successful checkpoint, execute one viewport PNG screenshot through ctx.executeTool. tool_result saves it under qa-diagnostics/<run UUID>/checkpoint-NNN.png and replaces the image result with short text. No screenshot paths or image data in QA reports.
- Capture failures are nonfatal, logged only to a separate diagnostic events.jsonl; no automatic retries. A normal successful checkpoint remains successful.
- Strip image blocks from active-QA model input, including historical messages. Remove screenshot result details/structuredContent duplicates. Keep useful DOM/text observations from other tools.
- Screenshot execution uses the existing Browse session/tool, never another browser controller. Preserve stop gates, cancellation and nested-call provenance.
- Tests: runtime discovery/target tracking, exactly one capture per successful checkpoint, no images/base64 in model contexts or report, nonfatal capture/storage failure, invalid checkpoints, terminal gating and old image history.
- Verify typecheck/full tests and fresh code review; real Browse browser capture still needs target-environment validation.
