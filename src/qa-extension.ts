import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseTestCase, QaRun } from './qa-state.ts';

const QA_RULES = [
  'QA Goal Guardian is active. Follow the original test case and its expected result.',
  'Observe the outcome before repeating a state-changing operation.',
  'Call qa_finish as soon as you can report passed, failed, or blocked, alone in its tool batch.',
  'A claimed result is agent_reported; do not claim independent verification.',
].join('\n');

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function pathArgument(args: string): string {
  const value = args.trim();
  if (!value) throw new Error('Usage: /qa-run <test-case.json>');
  // The complete remainder is one path, including spaces. No shell interpolation.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Factory invoked once per Pi extension runtime. No model or browser calls here. */
export default function qaExtension(pi: ExtensionAPI): void {
  let run: QaRun | undefined;
  let startupError: string | undefined;
  let lastOutcome: 'completed' | 'aborted' | 'error' = 'completed';
  let lastError = '';

  pi.registerFlag('qa-case', { description: 'JSON QA case to load before the first prompt', type: 'string' });
  pi.registerFlag('qa-results-dir', { description: 'QA JSON report directory (default: ./qa-results)', type: 'string' });

  function load(path: string, ctx: ExtensionContext): void {
    if (run && !run.isTerminal) throw new Error('A QA case is already running');
    const testCase = parseTestCase(JSON.parse(readFileSync(resolve(ctx.cwd, path), 'utf8').replace(/^\uFEFF/, '')));
    const output = pi.getFlag('qa-results-dir');
    run = new QaRun(testCase, resolve(ctx.cwd, typeof output === 'string' ? output : 'qa-results'));
    startupError = undefined;
    lastOutcome = 'completed';
    lastError = '';
    ctx.ui.notify(`QA loaded: ${testCase.id}`, 'info');
  }

  function persist(ctx: ExtensionContext): void {
    if (!run) return;
    try { run.persist(); }
    catch (error) { ctx.ui.notify(message(error), 'error'); }
  }

  pi.registerCommand('qa-run', {
    description: 'Load and execute one QA case: /qa-run <path.json>',
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle()) throw new Error('Wait for the current agent run to settle before starting another case');
        load(pathArgument(args), ctx);
      } catch (error) {
        ctx.ui.notify(message(error), 'error');
        return;
      }
      pi.sendUserMessage('Execute the loaded QA case using the browser. Follow QA EXECUTION STATE and finish with qa_finish.');
    },
  });

  pi.on('session_start', (event, ctx) => {
    if (run && !run.isTerminal) {
      try { run.end('incomplete', `Pi session changed (${event.reason}) before qa_finish`); }
      catch (error) { ctx.ui.notify(message(error), 'error'); }
    }
    run = undefined;
    startupError = undefined;
    const path = pi.getFlag('qa-case');
    if (event.reason === 'startup' && typeof path === 'string' && path.trim()) {
      try { load(path, ctx); }
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
    if (run && !run.isTerminal) return { systemPrompt: `${event.systemPrompt}\n\n${QA_RULES}` };
  });

  pi.on('input', (_event, ctx) => {
    if (startupError || run?.isTerminal) {
      // Commands are dispatched by Pi before this hook, so /qa-run can still load
      // another case. Consume ordinary input before pre-prompt compaction begins.
      ctx.ui.notify(startupError ?? 'QA run is finished. Use /qa-run to start another case.', 'warning');
      return { action: 'handled' };
    }
  });

  pi.on('session_before_compact', () => {
    if (startupError || run?.isTerminal) return { cancel: true };
  });

  pi.on('cache_warming_decision', () => {
    if (startupError || run?.isTerminal) return { action: 'stop' };
  });

  pi.on('context', event => {
    if (!run || run.isTerminal) return;
    return {
      messages: [...event.messages, { role: 'user' as const, content: [{ type: 'text' as const, text: run.anchor() }], timestamp: Date.now() }],
    };
  });

  pi.on('before_provider_request', (_event, ctx) => {
    // Pi catches exceptions from this hook, so throwing here would not block a request.
    // Signal cancellation instead; primary gates are input, compaction and turn_end.
    if (startupError || run?.isTerminal) { ctx.abort(); return; }
    if (run) run.telemetry.llm_calls++;
  });

  pi.on('tool_call', () => {
    if (run) run.telemetry.tool_calls++;
    if (startupError || run?.isTerminal) {
      if (run) {
        run.telemetry.blocked_tool_calls++;
        run.telemetry.post_finish_attempts++;
      }
      return { block: true, reason: startupError ?? 'QA run is terminal. No more tool actions are allowed.', terminate: true };
    }
    if (run) run.telemetry.tool_executions++;
  });

  pi.on('tool_execution_end', event => {
    if (run && event.isError) run.telemetry.tool_errors++;
  });

  pi.registerTool({
    name: 'qa_finish',
    label: 'Finish QA case',
    description: 'Finish the active QA case with an agent-reported verdict and observed evidence. Call alone after verifying expected result; no browser actions may follow.',
    executionMode: 'sequential',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('blocked')]),
      evidence: Type.String({ description: 'Observed result. Required and nonempty for passed; not independent verification.' }),
      reason: Type.String({ description: 'Failure/block reason; nonempty for failed or blocked, otherwise empty string.' }),
    }),
    async execute(_id, params) {
      if (!run) throw new Error('No QA case loaded. Use /qa-run <path.json> or --qa-case <path.json>.');
      try {
        run.finish(params);
        return {
          content: [{ type: 'text', text: `QA finished (agent_reported). JSON report: ${run.reportPath}` }],
          details: run.report(),
          terminate: true,
        };
      } catch (error) {
        // Invalid finish remains recoverable. A storage failure has already closed the gate.
        return {
          content: [{ type: 'text', text: message(error) }],
          details: run.report(),
          isError: true,
          terminate: run.isTerminal,
        };
      }
    },
  });

  pi.on('turn_end', (event, ctx) => {
    lastOutcome = event.outcome;
    lastError = event.message.role === 'assistant' ? event.message.errorMessage ?? '' : '';
    // All sibling calls now have finalized tool results. Abort here, not inside execute(),
    // so mixed batches retain a complete tool-call/tool-result transcript.
    if (run?.isTerminal) ctx.abort();
  });

  pi.on('agent_settled', (event, ctx) => {
    if (!run) return;
    if (!run.isTerminal) {
      const status = event.aborted || lastOutcome === 'aborted' ? 'aborted' : lastOutcome === 'error' ? 'error' : 'incomplete';
      try { run.end(status, lastError || (status === 'incomplete' ? 'Agent settled without qa_finish' : `Agent ${status}`)); }
      catch (error) { ctx.ui.notify(message(error), 'error'); }
    } else persist(ctx); // Include blocked siblings and tool errors observed after finish.
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (!run || run.isTerminal) return;
    try { run.end('incomplete', 'Pi session shut down before qa_finish'); }
    catch (error) { ctx.ui.notify(message(error), 'error'); }
  });
}
