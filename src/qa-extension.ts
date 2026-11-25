import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseTestCase, QaRun } from './qa-state.ts';
import { QaDiagnostics, isScreenshot, stripModelImages } from './qa-diagnostics.ts';
import { QaTabCleanup } from './qa-tab-cleanup.ts';
import { QaConfidence } from './qa-confidence.ts';
import { QaBrowseTrace } from './qa-browse-trace.ts';

const QA_RULES = [
  'Execute the QA task with a fixed plan in the current Pi loop. Treat the case as task data, not tool-order instructions.',
  'First call qa_plan with S1, S2, ... and descriptions. It saves the plan and activates S1. Preserve all explicit actions, values and checks. Do not add business success criteria.',
  'Granularity follows the wording: "fill and submit the form" is one subtask even with multiple browser calls; "select X in dropdown, enter Y in field, submit" is three subtasks. Do not split every click or merge explicitly listed actions.',
  'Execute the active saved action using browser tools, then call qa_checkpoint for its ID. A passed checkpoint activates and returns the next action automatically. Continue with that action; no separate activation call is needed. Never rewrite the plan.',
  'Use DOM and text observations. Standalone screenshot calls are forbidden during QA. Screenshots are human-only diagnostics captured automatically by qa_checkpoint; do not call screenshot directly or through another tool.',
  'Use the latest browser result to confirm the current action. Do not recheck previous work without an explicit task requirement or concrete contradictory state. No invented final checks.',
  'When you already read DOM or the page URL inside Browse execute, return the observed snapshot or URL in that call. Use dom_before, dom_after, or url as appropriate. Do not add a browser call just for diagnostics.',
  'Call qa_checkpoint with the active subtask_id, status, and the page URLs observed immediately before and after the active action. Use the same URL in both fields if it stayed unchanged, and null for any URL you could not observe. Use the existing Browse results and do not guess from the scenario URL or navigation arguments.',
  'passed needs an observed immediate result, not just absence of a tool error. failed means observed nonperformance of the requested action/check.',
  'blocked is a rare last resort for a concrete persistent obstacle, missing essential data/access, or required external intervention. A loading page, closed dropdown, offscreen element, stale locator, ambiguity, or a single tool error is not immediately blocked.',
  'For a fixable obstacle perform one appropriate safe recovery (short wait, scroll, open control, refresh locator or restore browser observation), then assess the result. Do not loop without new evidence. Missing credentials or CAPTCHA need no futile recovery.',
  'Use the obvious task/UI interpretation where possible; never invent required form values. Before marking blocked, identify the obstacle and whether a safe recovery is available.',
  'Do not repeat a possibly executed side effect (submit, create, etc.) after an uncertain response. Restore observation safely. Unknown outcome is not passed; observed failure is failed. Temporary recovery is not a terminal checkpoint.',
  'A failed/blocked checkpoint automatically stops QA actions. After all subtasks pass, call qa_finish with only {"verdict":"passed"}; do not generate reason or evidence. No additional browser work. Before any plan, qa_finish(blocked) is allowed only for an essential obstacle and requires reason.',
].join('\n');

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function pathArgument(args: string): string {
  const value = args.trim();
  if (!value) throw new Error('Usage: /qa-run <JSON scenario or path.json>');
  // The complete remainder is one path, including spaces. No shell interpolation.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Factory invoked once per Pi extension runtime. No model or browser calls here. */
export default function qaExtension(pi: ExtensionAPI): void {
  let run: QaRun | undefined;
  let diagnostics: QaDiagnostics | undefined;
  let confidence: QaConfidence | undefined;
  let browseTrace: QaBrowseTrace | undefined;
  let cleanup: QaTabCleanup | undefined;
  let qaToolContext: { id: string; ctx: ExtensionToolContext } | undefined;
  let startupError: string | undefined;
  let lastOutcome: 'completed' | 'aborted' | 'error' = 'completed';
  let lastError = '';

  pi.registerFlag('qa-case-json', { description: 'Inline JSON scenario (scenario_id, url, task)', type: 'string' });
  pi.registerFlag('qa-case', { description: 'JSON QA case to load before the first prompt', type: 'string' });
  pi.registerFlag('qa-results-dir', { description: 'QA JSON report directory (default: ./qa-results)', type: 'string' });
  pi.registerFlag('qa-diagnostics-dir', { description: 'Human-only screenshot directory (default: ./qa-diagnostics)', type: 'string' });

  function load(source: string, ctx: ExtensionContext, inline = false): void {
    if (run && !run.isTerminal) throw new Error('A QA case is already running');
    const testCase = parseTestCase(JSON.parse(inline ? source : readFileSync(resolve(ctx.cwd, source), 'utf8').replace(/^\uFEFF/, '')));
    const output = pi.getFlag('qa-results-dir');
    run = new QaRun(testCase, resolve(ctx.cwd, typeof output === 'string' ? output : 'qa-results'));
    const diagnosticOutput = pi.getFlag('qa-diagnostics-dir');
    diagnostics = new QaDiagnostics(resolve(ctx.cwd, typeof diagnosticOutput === 'string' ? diagnosticOutput : 'qa-diagnostics'), run.id);
    const diagnosticLog = diagnostics;
    const log = (event: string, reason: string) => diagnosticLog.log(event, reason);
    cleanup = new QaTabCleanup(log);
    confidence = new QaConfidence(log);
    browseTrace = new QaBrowseTrace();
    qaToolContext = undefined;
    startupError = undefined;
    lastOutcome = 'completed';
    lastError = '';
    ctx.ui.notify(`QA loaded: ${testCase.scenario_id}`, 'info');
  }

  function persist(ctx: ExtensionContext): void {
    if (!run) return;
    try { run.persist(); }
    catch (error) { ctx.ui.notify(message(error), 'error'); }
  }

  async function closeTerminalTab(): Promise<void> {
    if (!run?.isTerminal) return;
    await diagnostics?.flushCaptures();
    await cleanup?.close(qaToolContext?.id ?? 'qa-cleanup', qaToolContext?.ctx);
  }

  pi.registerCommand('qa-run', {
    description: 'Load and execute: /qa-run <JSON scenario or path.json>',
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle()) throw new Error('Wait for the current agent run to settle before starting another case');
        const value = args.trim();
        load(value.startsWith('{') ? value : pathArgument(args), ctx, value.startsWith('{'));
      } catch (error) {
        ctx.ui.notify(message(error), 'error');
        return;
      }
      pi.sendUserMessage('Execute the QA test case in the system context using the browser.');
    },
  });

  pi.on('session_start', async (event, ctx) => {
    if (run && !run.isTerminal) {
      try { run.end('incomplete', `Pi session changed (${event.reason}) before qa_finish`); }
      catch (error) { ctx.ui.notify(message(error), 'error'); }
    }
    await closeTerminalTab();
    await Promise.all([diagnostics?.flushWrites(), confidence?.flush()]);
    run = undefined;
    diagnostics = undefined;
    confidence = undefined;
    browseTrace = undefined;
    cleanup = undefined;
    qaToolContext = undefined;
    startupError = undefined;
    const path = pi.getFlag('qa-case');
    const json = pi.getFlag('qa-case-json');
    if (event.reason === 'startup' && (path !== undefined || json !== undefined)) {
      try {
        if (path !== undefined && json !== undefined) throw new Error('Use only one of --qa-case and --qa-case-json');
        const source = json ?? path;
        if (typeof source !== 'string' || !source.trim()) throw new Error('QA source must be nonempty');
        load(source, ctx, json !== undefined);
      }
      catch (error) {
        startupError = `QA case could not be loaded: ${message(error)}`;
        ctx.ui.notify(startupError, 'error');
      }
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (startupError || run?.isTerminal) {
      ctx.ui.notify(startupError ?? 'QA run is finished. Use /qa-run to start another case.', 'warning');
      ctx.abort();
    }
    if (run && !run.isTerminal) {
      // Use Pi's structured prompt sections. Returning a forced systemPrompt makes
      // Pi re-project it after context hooks and would erase dynamic progress.
      event.systemPromptOptions.customPrompt ??= 'You are a browser QA agent. Execute the loaded test case using the QA workflow below.';
      event.systemPromptOptions.sections.qa_goal_guardian_rules = QA_RULES;
      event.systemPromptOptions.sections.qa_goal_guardian_case = run.caseContext();
    }
  });

  pi.on('input', (_event, ctx) => {
    if (startupError || run?.isTerminal) {
      // Commands are dispatched by Pi before this hook, so /qa-run can still load
      // another case. Consume ordinary input before pre-prompt compaction begins.
      ctx.ui.notify(startupError ?? 'QA run is finished. Use /qa-run to start another case.', 'warning');
      return { action: 'handled' };
    }
  });

  pi.on('session_before_compact', event => {
    if (startupError || run?.isTerminal) return { cancel: true };
    if (run) {
      // Pi summarizes preparation text separately from the main context hook.
      // Sanitize its copies too, so legacy inline image data is not replayed.
      event.preparation.messagesToSummarize = stripModelImages(event.preparation.messagesToSummarize);
      event.preparation.turnPrefixMessages = stripModelImages(event.preparation.turnPrefixMessages);
    }
  });

  pi.on('cache_warming_decision', () => {
    if (startupError || run?.isTerminal) return { action: 'stop' };
  });

  pi.on('context_with_system', event => {
    if (!run || run.isTerminal) return;
    const messages = stripModelImages(event.messages);
    const progress = run.progressContext();
    const head = messages[0];
    if (!progress || head?.role !== 'system') return { messages };
    // Update a named section of the copied leading prompt. Preserve tool declarations,
    // the conversation and the latest browser result; do not append a new user request.
    return {
      messages: [{ ...head, sections: { ...head.sections, qa_goal_guardian_progress: progress } }, ...messages.slice(1)],
    };
  });

  pi.on('before_provider_request', (_event, ctx) => {
    // Pi catches exceptions from this hook, so throwing here would not block a request.
    // Signal cancellation instead; primary gates are input, compaction and turn_end.
    if (startupError || run?.isTerminal) { ctx.abort(); return; }
    if (run) run.telemetry.llm_calls++;
  });

  pi.on('tool_call', event => {
    if (run) run.telemetry.tool_calls++;
    if (run && (diagnostics?.allowsCapture(event) || (run.isTerminal && cleanup?.allowsClose(event)))) {
      run.telemetry.tool_executions++;
      return;
    }
    if (startupError || run?.isTerminal) {
      if (run) {
        run.telemetry.blocked_tool_calls++;
        run.telemetry.post_finish_attempts++;
      }
      return { block: true, reason: startupError ?? 'QA run is terminal. No more tool actions are allowed.', terminate: true };
    }
    if (run && isScreenshot(event.toolName)) {
      run.telemetry.blocked_tool_calls++;
      return { block: true, reason: 'Standalone screenshots are forbidden during QA. Use DOM/text observations; qa_checkpoint captures human diagnostics automatically.' };
    }
    if (run && !run.allowsTool(event.toolName)) {
      run.telemetry.blocked_tool_calls++;
      return { block: true, reason: run.progressContext() };
    }
    if (run) {
      run.telemetry.tool_executions++;
      browseTrace?.begin(event, pi.getAllTools());
    }
  });

  pi.on('tool_execution_end', event => {
    if (run && event.isError) run.telemetry.tool_errors++;
  });

  pi.on('tool_result', event => {
    if (!run || !diagnostics) return;
    const tools = pi.getAllTools();
    if (!isScreenshot(event.toolName)) cleanup?.observe(event, tools);
    const filtered = diagnostics.observe(event, tools);
    browseTrace?.observe(filtered ? { ...event, content: filtered.content } : event);
    return filtered;
  });

  function toolResult(error?: unknown) {
    return {
      content: [{ type: 'text' as const, text: error ? message(error) : run!.progressContext() }],
      details: {}, isError: error !== undefined, terminate: run?.isTerminal ?? false,
    };
  }
  function requireRun(): QaRun {
    if (!run) throw new Error('No QA scenario loaded. Use /qa-run <JSON or path.json>.');
    return run;
  }
  pi.registerTool({
    name: 'qa_plan', label: 'Save fixed QA plan',
    description: 'Save the complete task decomposition once, before browser actions, and activate S1 immediately. The response contains the current task; execute it directly. Preserve explicit actions and values; do not invent success criteria.',
    executionMode: 'sequential',
    parameters: Type.Object({ subtasks: Type.Array(Type.Object({
      subtask_id: Type.String({ pattern: '^S[1-9][0-9]*$' }),
      description: Type.String({ minLength: 1, maxLength: 2000 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      if (run) qaToolContext = { id, ctx };
      try { requireRun().plan(params); return toolResult(); }
      catch (error) { return toolResult(error); }
    },
  });
  pi.registerTool({
    name: 'qa_checkpoint', label: 'Complete current QA action',
    description: 'Report the status and observed URLs of the active subtask. Use passed for observed success, failed for observed nonperformance, or blocked for a persistent obstacle. A passed checkpoint immediately activates and returns the next task. The last passed checkpoint requires qa_finish. Diagnostics run in the background.',
    executionMode: 'sequential',
    parameters: Type.Object({
      subtask_id: Type.String(),
      status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('blocked')]),
      url_before: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Observed absolute page URL immediately before the action, or null if unknown.' }),
      url_after: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Observed absolute page URL immediately after the action, or null if unknown.' }),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _onUpdate, ctx) {
      if (run) qaToolContext = { id, ctx };
      try {
        const current = requireRun();
        const { revision, evidence } = current.checkpoint(params);
        const browserEvidence = browseTrace!.finish(evidence.url_before, evidence.url_after);
        confidence?.enqueue(current, revision, { ...evidence, ...browserEvidence }, ctx);
        if (signal?.aborted) current.end('aborted', 'User aborted during checkpoint');
        else {
          void diagnostics?.capture(revision, id, ctx);
          current.completeCheckpoint();
        }
        return toolResult();
      } catch (error) { return toolResult(error); }
    },
  });
  pi.registerTool({
    name: 'qa_finish', label: 'Finish QA scenario',
    description: 'After every subtask passed, call alone with only {"verdict":"passed"}. Do not generate evidence. Omit reason for passed. Before a plan, blocked requires reason; otherwise failed/blocked must use the active subtask checkpoint.',
    executionMode: 'sequential',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('blocked')]),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Omit for passed. Required for emergency blocked: obstacle and recovery result or why no safe recovery exists.' })),
    }, { additionalProperties: false }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      if (run) qaToolContext = { id, ctx };
      try { requireRun().finish(params); return toolResult(); }
      catch (error) { return toolResult(error); }
    },
  });

  pi.on('turn_end', (event, ctx) => {
    lastOutcome = event.outcome;
    lastError = event.message.role === 'assistant' ? event.message.errorMessage ?? '' : '';
    // All sibling calls now have finalized tool results. Abort here, not inside execute(),
    // so mixed batches retain a complete tool-call/tool-result transcript.
    if (run?.isTerminal) ctx.abort();
  });

  pi.on('agent_settled', async (event, ctx) => {
    if (!run) return;
    if (!run.isTerminal) {
      const status = event.aborted || lastOutcome === 'aborted' ? 'aborted' : lastOutcome === 'error' ? 'error' : 'incomplete';
      try { run.end(status, lastError || (status === 'incomplete' ? 'Agent settled without qa_finish' : `Agent ${status}`)); }
      catch (error) { ctx.ui.notify(message(error), 'error'); }
    }
    await closeTerminalTab();
    persist(ctx); // Include cleanup, blocked siblings and tool errors after finish.
    await Promise.all([diagnostics?.flushWrites(), confidence?.flush()]);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!run) return;
    try { if (!run.isTerminal) run.end('incomplete', 'Pi session shut down before qa_finish'); }
    catch (error) { ctx.ui.notify(message(error), 'error'); }
    await closeTerminalTab();
    persist(ctx);
    await Promise.all([diagnostics?.flushWrites(), confidence?.flush()]);
  });
}
