import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentSession, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, type AssistantMessage, type Model, type ToolCall, type Context, type TranscriptContext, type Api, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import qaExtension from '../src/qa-extension.ts';

const model: Model<'openai-completions'> = {
  id: 'deterministic-qa-test', name: 'Local deterministic test', api: 'openai-completions',
  provider: 'qa-test', baseUrl: 'http://127.0.0.1:1/never-used', reasoning: false,
  input: ['text'], contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const finish = (id = 'finish'): ToolCall => ({ type: 'toolCall', id, name: 'qa_finish', arguments: { verdict: 'passed' } });
const browser = (id: string): ToolCall => ({ type: 'toolCall', id, name: 'browser_execute', arguments: { action: id } });
const call = (name: string, id: string, args: ToolCall['arguments']): ToolCall => ({ type: 'toolCall', name, id, arguments: args });
const plan = (count = 1) => call('qa_plan', 'plan', { subtasks: Array.from({ length: count }, (_, i) => ({ subtask_id: 'S'+(i+1), description: 'Action '+(i+1) })) });
const checkpoint = (id = 'S1', status = 'passed', observation = 'Value visible', reason = '') => call('qa_checkpoint', 'cp-'+id, {
  subtask_id: id, status, observation, reason,
  confidence_score: status === 'passed' ? 92.5 : 0,
  url_before: 'https://example.com/form',
  url_after: status === 'passed' ? 'https://example.com/result' : null,
  reasoning: status === 'passed' ? 'The result page shows the saved value.' : reason,
});
const success = () => [plan(), browser('work'), checkpoint(), finish()];
const navigate = () => call('mcp__browse__navigate', 'navigate', { tab: 'chrome:7' });
const screenshot = () => call('mcp__browse__screenshot', 'model-shot', { tab: 'chrome:7' });

type Reply = { calls?: ToolCall[]; stopReason?: Exclude<AssistantMessage['stopReason'], 'pending'>; errorMessage?: string; waitForAbort?: boolean; usageInput?: number };

async function setup(t: TestContext, replies: Reply[], options: { brokenOutput?: boolean; startupCase?: boolean; invalidCase?: boolean; fromDisk?: boolean; compaction?: boolean; retry?: boolean; compactionFixture?: boolean; screenshots?: 'ok' | 'error' | 'bad-storage'; inline?: boolean; startupJson?: boolean; conflict?: boolean; captureStarted?: () => void; captureWait?: Promise<void>; closeTab?: 'ok' | 'error' | 'throw'; onClose?: () => void; onRequest?: (count: number) => void } = {}) {
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  const casePath = join(dir, 'case with spaces.json');
  const caseJson = JSON.stringify({ scenario_id: options.invalidCase ? '' : 'TC-001', url: 'https://example.com', task: 'Create the item exactly once' });
  writeFileSync(casePath, caseJson);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false, keepRecentTokens: 1, reserveTokens: 32 },
    retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 }, packages: [],
  });
  let compactions = 0;
  const compactionFixture: ExtensionFactory = pi => {
    pi.on('session_before_compact', event => {
      compactions++;
      return { compaction: {
        summary: 'Prior navigation summarized; no checkpoint details retained in this summary.',
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: options.fromDisk ? [] : [qaExtension, ...(options.compactionFixture ? [compactionFixture] : [])],
    additionalExtensionPaths: options.fromDisk ? [join(process.cwd(), '.pi/extensions/qa.ts')] : [],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  if (options.startupJson || options.conflict) loader.getExtensions().runtime.flagValues.set('qa-case-json', caseJson);
  if (options.startupCase || options.conflict) loader.getExtensions().runtime.flagValues.set('qa-case', casePath);
  if (options.brokenOutput) {
    const file = join(dir, 'occupied');
    writeFileSync(file, 'not a directory');
    loader.getExtensions().runtime.flagValues.set('qa-results-dir', file);
  }
  const actions: string[] = [];
  const screenshotCalls: unknown[] = [];
  const closeCalls: unknown[] = [];
  const lifecycle: string[] = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=';
  const customTools: ToolDefinition[] = [defineTool({
    name: 'browser_execute', label: 'browser', description: 'Test browser side effect',
    parameters: Type.Object({ action: Type.String() }),
    async execute(_id, params) {
      if (params.action === 'break-report') {
        const output = join(dir, 'qa-results');
        assert.equal(dirname(output), dir);
        rmSync(output, { recursive: true, force: true }); writeFileSync(output, 'occupied');
      }
      if (params.action === 'error') throw new Error('Browser disconnected');
      actions.push(params.action);
      return { content: [{ type: 'text', text: 'Observed page' }], details: {} };
    },
  })];
  if (options.screenshots || options.closeTab) {
    customTools.push(defineTool({
      name: 'mcp__browse__navigate', label: 'Navigate', description: 'Browse navigation fixture',
      parameters: Type.Object({ tab: Type.String() }),
      async execute(_id, params) {
        actions.push('navigate');
        return { content: [{ type: 'text', text: JSON.stringify({ tab: params.tab }) }], details: {} };
      },
    }));
    if (options.screenshots) customTools.push(defineTool({
      name: 'mcp__browse__screenshot', label: 'Screenshot', description: 'Capture the tab as an image',
      parameters: Type.Object({ tab: Type.String(), format: Type.Optional(Type.Literal('png')) }),
      async execute(_id, params) {
        screenshotCalls.push(params);
        lifecycle.push('screenshot');
        options.captureStarted?.();
        await options.captureWait;
        if (options.screenshots === 'error') throw new Error('Screenshot backend unavailable');
        return {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          details: { duplicateImage: { type: 'image', data: png, mimeType: 'image/png' } },
          structuredContent: { media: [{ type: 'image', data: png, mimeType: 'image/png' }] },
        };
      },
    }));
    if (options.screenshots) customTools.push(defineTool({
      name: 'mcp__browse__capture_via_wrapper', label: 'Nested capture test', description: 'Fixture for nested screenshot calls',
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        const outcome = await ctx.executeTool('mcp__browse__screenshot', { tab: 'chrome:7' });
        return { ...outcome.result, isError: outcome.isError };
      },
    }));
    if (options.screenshots === 'bad-storage') {
      writeFileSync(join(dir, 'qa-diagnostics'), 'not a directory');
    }
  }
  if (options.closeTab) customTools.push(defineTool({
    name: 'mcp__browse__tabs', label: 'Browse tabs', description: 'List, open or close Browse tabs',
    parameters: Type.Object({ action: Type.Optional(Type.String({ enum: ['list', 'new', 'close'] })), tab: Type.Optional(Type.Union([Type.Integer(), Type.String()])) }),
    async execute(_id, params, signal) {
      assert.equal(signal?.aborted, false);
      if (params.action === 'list' || params.action === undefined) return { content: [{ type: 'text', text: JSON.stringify({ tabs: [{ tab: 999 }] }) }], details: {} };
      assert.equal(params.action, 'close');
      assert.equal(params.tab, 'chrome:7');
      closeCalls.push(params); lifecycle.push('close'); options.onClose?.();
      if (options.closeTab === 'throw') throw new Error('Close disconnected');
      return { content: [{ type: 'text', text: 'Tab close response' }], details: {}, isError: options.closeTab === 'error' };
    },
  }));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: join(dir, 'agent'), model, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir), settingsManager: settings,
    noTools: 'builtin', customTools,
    modelRuntime: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false }),
  });
  // Pi performs an auth preflight even with a substituted stream. This is a public,
  // deliberately fake fixture credential; no external API is ever called.
  const contexts: Context[] = [];
  let requests = 0;
  let started!: () => void;
  const whenRequested = new Promise<void>(resolve => { started = resolve; });
  const deterministicStream = (_model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const aborted = streamOptions?.signal?.aborted;
      const reply = aborted ? { stopReason: 'aborted' as const } : replies[requests];
      if (!aborted) {
        requests++;
        options.onRequest?.(requests);
        contexts.push(structuredClone(context));
        await streamOptions?.onPayload?.({ test_request: requests }, model);
        started();
      }
      if (reply?.waitForAbort && !streamOptions?.signal?.aborted) {
        await new Promise<void>(resolve => streamOptions?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
      const stopReason = streamOptions?.signal?.aborted ? 'aborted' : reply?.stopReason ?? (reply?.calls?.length ? 'toolUse' : 'stop');
      const message: AssistantMessage = {
        role: 'assistant', content: reply?.calls ?? [{ type: 'text', text: 'Done' }],
        api: model.api, provider: model.provider, model: model.id, stopReason,
        errorMessage: reply?.errorMessage, timestamp: Date.now(),
        usage: { input: reply?.usageInput ?? 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: (reply?.usageInput ?? 20) + 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (stopReason === 'error' || stopReason === 'aborted') stream.push({ type: 'error', reason: stopReason, error: message });
      else stream.push({ type: 'done', reason: stopReason, message });
      stream.end();
    })().catch(error => stream.end({
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: 'error', errorMessage: String(error), timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }));
    return stream;
  };
  session.agent.streamFunction = deterministicStream;
  session.modelRuntime.registerProvider('qa-test', {
    api: model.api, baseUrl: model.baseUrl, apiKey: 'local-test-placeholder', models: [model],
    streamSimple: deterministicStream,
  });
  const extensionErrors: string[] = [];
  await session.bindExtensions({ mode: 'print', onError: error => extensionErrors.push(error.error) });
  t.after(async () => {
    await session.abort();
    session.dispose();
    await session.modelRuntime.settleCredentialWrites();
    assert.equal(dirname(dir), process.cwd());
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    session, dir, actions, contexts, extensionErrors, whenRequested, screenshotCalls, closeCalls, lifecycle,
    requests: () => requests,
    compactions: () => compactions,
    async run() {
      if (options.startupCase || options.startupJson || options.conflict) await session.prompt('Execute QA case');
      else {
        // sendUserMessage intentionally schedules asynchronously. The command can
        // return before Pi marks the run busy; wait for its actual settlement event.
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = session.subscribe(event => {
            if (event.type === 'agent_settled') { unsubscribe(); resolve(); }
          });
          void session.prompt(options.inline ? `/qa-run ${caseJson}` : `/qa-run "${casePath}"`).catch(error => { unsubscribe(); reject(error); });
        });
      }
      await session.waitForIdle();
    },
    reports() {
      const output = join(dir, 'qa-results');
      return readdirSync(output).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(output, name), 'utf8')));
    },
  };
}
for (const options of [{}, { inline: true }, { startupJson: true }, { fromDisk: true, startupCase: true }]) {
  test(`full lifecycle via ${JSON.stringify(options)}`, async t => {
    const env = await setup(t, [{ calls: success() }], options);
    await env.run();
    assert.deepEqual(env.actions, ['work']);
    const [report] = env.reports();
    assert.equal(report.reported_verdict, 'passed');
    assert.equal(report.execution_status, 'completed');
    assert.equal(report.scenario_id, 'TC-001');
    assert.equal(report.subtask_results.length, 1);
    const { confidence_score, url_before, url_after, reasoning } = report.subtask_results[0];
    assert.deepEqual({ confidence_score, url_before, url_after, reasoning }, {
      confidence_score: 92.5,
      url_before: 'https://example.com/form',
      url_after: 'https://example.com/result',
      reasoning: 'The result page shows the saved value.',
    });
    assert.equal(report.progress.revision, 1);
    assert.equal(report.verified_verdict, null);
    assert.equal(env.requests(), 1);
    assert.deepEqual(env.extensionErrors, []);
  });
}

test('QA requests replace Pi coding instructions and retain case, progress, and tools', async t => {
  const env = await setup(t, [{}, { calls: [plan()] }, { calls: [browser('work'), checkpoint(), finish()] }]);
  await env.session.prompt('Ordinary Pi request');
  await env.run();

  assert.match(getCurrentSystemPrompt(env.contexts[0].messages), /coding assistant running inside pi/);
  for (const context of env.contexts.slice(1)) {
    const prompt = getCurrentSystemPrompt(context.messages);
    assert.doesNotMatch(prompt, /coding assistant running inside pi|<tools>|<rules>|<docs>/);
    assert.match(prompt, /Create the item exactly once/);
    assert.match(prompt, /First call qa_plan/);
    assert.ok(getCurrentTools(context.messages).some(tool => tool.name === 'browser_execute'));
  }
  assert.match(getCurrentSystemPrompt(env.contexts[2].messages), /"subtask_id":"S1"/);
});

test('stage gates reject pre-plan browser, skipped and duplicate checkpoint IDs in a mixed packet', async t => {
  const calls = [browser('before-plan'), finish('premature'), plan(2), checkpoint('S2'), browser('first'), checkpoint(), checkpoint('S1'), browser('second'), checkpoint('S2'), browser('after-tasks'), finish(), browser('after-finish')];
  const env = await setup(t, [{ calls }]); await env.run();
  assert.deepEqual(env.actions, ['first', 'second']);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
  assert.equal(env.session.messages.filter(m => m.role === 'toolResult').length, calls.length);
  assert.equal(env.requests(), 1);
});

test('invalid checkpoint stays recoverable and duplicate cannot add a revision', async t => {
  const env = await setup(t, [{ calls: [plan(), checkpoint('S1', 'passed', ' '), browser('recover'), checkpoint(), checkpoint(), finish()] }]);
  await env.run(); assert.deepEqual(env.actions, ['recover']);
  assert.equal(env.reports()[0].subtask_results.length, 1);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
});

for (const status of ['failed', 'blocked'] as const) test(`${status} checkpoint captures once and stops later siblings`, async t => {
  const env = await setup(t, [{ calls: [plan(2), navigate(), checkpoint('S1', status, '', 'Missing credentials; no safe recovery available'), screenshot(), browser('after')] }], { screenshots: 'ok' });
  await env.run(); assert.deepEqual(env.actions, ['navigate']);
  assert.equal(env.screenshotCalls.length, 1);
  const [report] = env.reports();
  assert.equal(report.reported_verdict, status);
  assert.equal(report.subtask_results.length, 1);
  assert.ok(existsSync(join(env.dir, 'qa-diagnostics', report.run_id, 'checkpoint-001.png')));
  assert.equal(env.requests(), 1); assert.deepEqual(env.extensionErrors, []);
});

test('next subtask runs while capture is pending and model screenshots stay blocked', async t => {
  let started!: () => void, release!: () => void, nextRequest!: () => void;
  const captured = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const continued = new Promise<boolean>(r => { nextRequest = () => r(true); });
  const env = await setup(t, [
    { calls: [plan(2), navigate(), checkpoint(), browser('second'), screenshot()] },
    { calls: [checkpoint('S2'), finish()] },
  ], { screenshots: 'ok', captureStarted: started, captureWait: wait, onRequest: n => { if (n === 2) nextRequest(); } });
  const running = env.run(); await captured;
  const timeout = new Promise<boolean>(r => AbortSignal.timeout(2000).addEventListener('abort', () => r(false)));
  try {
    assert.equal(await Promise.race([continued, timeout]), true, 'QA should continue while screenshot is pending');
    assert.deepEqual(env.actions, ['navigate', 'second']);
    const denied = env.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'model-shot');
    assert.ok(denied?.role === 'toolResult' && denied.isError);
  } finally {
    release();
    await running;
  }
  assert.equal(env.screenshotCalls.length, 2);
  const imageDir = join(env.dir, 'qa-diagnostics', env.reports()[0].run_id);
  assert.ok(existsSync(join(imageDir, 'checkpoint-001.png')));
  assert.ok(existsSync(join(imageDir, 'checkpoint-002.png')));
});

test('abort during failed capture preserves accepted verdict', async t => {
  let started!: () => void, release!: () => void;
  const captured = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const env = await setup(t, [{ calls: [plan(), navigate(), checkpoint('S1', 'failed', '', 'Value did not change'), browser('after')] }], { screenshots: 'ok', captureStarted: started, captureWait: wait });
  const running = env.run(); await captured;
  const aborting = env.session.abort(); release(); await aborting; await running;
  assert.equal(env.reports()[0].reported_verdict, 'failed');
  assert.equal(env.reports()[0].subtask_results.length, 1);
  assert.deepEqual(env.actions, ['navigate']);
});

for (const screenshots of ['ok', 'error', 'bad-storage'] as const) test(`diagnostics ${screenshots}: one attempt, no image bytes in model/report`, async t => {
  const env = await setup(t, [{ calls: [plan(), navigate(), checkpoint('S1', 'passed', ' '), checkpoint()] }, { calls: [finish()] }], { screenshots });
  await env.run(); assert.equal(env.screenshotCalls.length, 1);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
  assert.doesNotMatch(JSON.stringify(env.contexts), /iVBOR|image\/png|qa-diagnostics|checkpoint-001\.png/);
  assert.doesNotMatch(JSON.stringify(env.reports()), /iVBOR|image\/png|qa-diagnostics/);
  assert.doesNotMatch(JSON.stringify(env.session.messages), /iVBOR|image\/png/);
});

test('current task survives compaction in short state', async t => {
  const env = await setup(t, [{ calls: [plan(2), browser('first'), checkpoint()], usageInput: 128000 }, { calls: [browser('second'), checkpoint('S2'), finish()] }], { compaction: true, compactionFixture: true });
  await env.run(); assert.ok(env.compactions() >= 1);
  const progress = getCurrentSystemMessage(env.contexts[1].messages)?.sections?.qa_goal_guardian_progress ?? '';
  assert.match(progress, /Action 2/); assert.doesNotMatch(progress, /Action 1/);
  assert.match(getCurrentSystemPrompt(env.contexts[1].messages), /Create the item exactly once/);
  assert.equal(env.reports()[0].subtask_results.length, 2);
  assert.deepEqual(env.extensionErrors, []);
});

test('browser error is recoverable; rules specify rare blocked and safe recovery', async t => {
  const env = await setup(t, [{ calls: [plan(), browser('error')] }, { calls: [browser('recover'), checkpoint(), finish()] }]);
  await env.run(); assert.deepEqual(env.actions, ['recover']);
  assert.equal(env.reports()[0].telemetry.tool_errors, 1, JSON.stringify(env.session.messages.filter(m => m.role === 'toolResult' && m.isError)));
  assert.equal(env.reports()[0].reported_verdict, 'passed');
  const rules = getCurrentSystemMessage(env.contexts[0].messages)?.sections?.qa_goal_guardian_rules ?? '';
  assert.match(rules, /safe recovery/); assert.match(rules, /Do not repeat.*side effect/);
  assert.match(rules, /one subtask/); assert.match(rules, /three subtasks/);
  assert.doesNotMatch(getCurrentSystemPrompt(env.contexts[0].messages), /expected_result|"expected"/);
  assert.equal(env.contexts[1].messages.at(-1)?.role, 'toolResult');
  assert.equal(env.contexts[1].messages.filter(m => m.role === 'user').length, 1);
  assert.deepEqual(getCurrentTools(env.contexts[1].messages).map(t => t.name).sort(), ['browser_execute', 'qa_checkpoint', 'qa_finish', 'qa_plan']);
});

for (const options of [{ startupCase: true, invalidCase: true }, { startupJson: true, invalidCase: true }, { conflict: true }]) test(`invalid startup fails closed: ${JSON.stringify(options)}`, async t => {
  const env = await setup(t, [{ calls: [browser('never')] }], options);
  await env.run(); assert.equal(env.requests(), 0); assert.deepEqual(env.actions, []);
});

test('terminal input stays closed after invalid replacement, compaction and warming cancelled', async t => {
  const env = await setup(t, [{ calls: success() }]); await env.run();
  await env.session.prompt('/qa-run {broken'); await env.session.prompt('/qa-run missing-case.json');
  await env.session.prompt('Continue'); await env.session.waitForIdle();
  assert.equal(env.requests(), 1); assert.equal(env.reports().length, 1);
  await assert.rejects(env.session.compact(), /cancelled/i);
  const action = await env.session.extensionRunner.emitCacheWarmingDecision({ type: 'cache_warming_decision', action: 'warm', warmCost: 0, missCost: 1, continuationProbability: 1 });
  assert.equal(action, 'stop');
});

test('two runs reset plan, context and counters', async t => {
  const env = await setup(t, [{ calls: success() }, { calls: success() }]); await env.run(); await env.run();
  assert.equal(env.reports().length, 2);
  for (const context of env.contexts) assert.match(getCurrentSystemMessage(context.messages)?.sections?.qa_goal_guardian_progress ?? '', /planning/);
  assert.ok(env.reports().every(r => r.telemetry.llm_calls === 1 && r.reported_verdict === 'passed'));
});

for (const [stopReason, status] of [['stop', 'incomplete'], ['error', 'error'], ['aborted', 'aborted']] as const) test(`settlement ${stopReason} remains technical ${status}`, async t => {
  const env = await setup(t, [{ calls: [plan()] }, { stopReason, errorMessage: stopReason === 'error' ? 'Inference unavailable' : undefined }]);
  await env.run(); assert.equal(env.reports()[0].execution_status, status); assert.equal(env.reports()[0].reported_verdict, null);
});

test('user abort then reload does not resume browser work', async t => {
  const env = await setup(t, [{ waitForAbort: true }]);
  const running = env.run(); await env.whenRequested; await env.session.abort(); await running;
  assert.equal(env.reports()[0].execution_status, 'aborted');
  await env.session.reload(); await env.session.prompt('Normal prompt'); assert.equal(env.requests(), 2);
});

test('reload unstarted case records incomplete', async t => {
  const env = await setup(t, [], { startupCase: true }); await env.session.reload();
  assert.equal(env.reports()[0].execution_status, 'incomplete');
});

test('Pi retry recovers without premature incomplete', async t => {
  const env = await setup(t, [{ stopReason: 'error', errorMessage: '503 Service Unavailable' }, { calls: success() }], { retry: true });
  await env.run(); assert.equal(env.requests(), 2); assert.equal(env.reports()[0].reported_verdict, 'passed');
});

test('storage failure closes gate before browser and further provider requests', async t => {
  const env = await setup(t, [{ calls: [plan(), browser('after')] }], { brokenOutput: true });
  await env.run(); assert.deepEqual(env.actions, []); assert.equal(env.requests(), 1);
  assert.ok(env.session.messages.some(m => m.role === 'toolResult' && m.toolName === 'qa_plan' && m.isError));
});

const closeCall = () => call('mcp__browse__tabs', 'model-close', { action: 'close', tab: 'chrome:7' });
for (const status of ['passed', 'failed', 'blocked'] as const) test(`automatic tab close after ${status} preserves verdict and rejects model siblings`, async t => {
  const calls = [plan(), navigate(), checkpoint('S1', status, 'Observed result', status === 'passed' ? '' : 'Persistent obstacle after safe recovery')];
  if (status === 'passed') calls.push(finish());
  calls.push(closeCall(), browser('after'));
  const env = await setup(t, [{ calls }], { closeTab: 'ok', screenshots: 'ok', onClose: () => {
    assert.equal(env.reports()[0].execution_status, 'completed');
  } });
  await env.run();
  assert.ok(existsSync(join(env.dir, 'qa-diagnostics', env.reports()[0].run_id, 'checkpoint-001.png')));
  assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.deepEqual(env.lifecycle, ['screenshot', 'close']);
  assert.deepEqual(env.actions, ['navigate']);
  assert.equal(env.reports()[0].reported_verdict, status);
  assert.equal(env.requests(), 1);
  assert.deepEqual(env.extensionErrors, []);
});

for (const [stopReason, status] of [['stop', 'incomplete'], ['error', 'error'], ['aborted', 'aborted']] as const) test(`technical ${status} closes tab from settlement`, async t => {
  const env = await setup(t, [{ calls: [plan(), navigate()] }, { stopReason, errorMessage: 'Technical stop' }], { closeTab: 'ok' });
  await env.run(); assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.equal(env.reports()[0].execution_status, status);
  assert.equal(env.reports()[0].reported_verdict, null);
  assert.equal(env.screenshotCalls.length, 0);
});

test('real user abort closes tab with an independent cleanup signal', async t => {
  let ready!: () => void; const second = new Promise<void>(resolve => { ready = resolve; });
  const env = await setup(t, [{ calls: [plan(), navigate()] }, { waitForAbort: true }], { closeTab: 'ok', onRequest: n => { if (n === 2) ready(); } });
  const running = env.run(); await second; await env.session.abort(); await running;
  assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.equal(env.reports()[0].execution_status, 'aborted');
});

test('abort during checkpoint diagnostics closes only after capture returns', async t => {
  let started!: () => void, release!: () => void;
  const captured = new Promise<void>(r => { started = r; }); const wait = new Promise<void>(r => { release = r; });
  const env = await setup(t, [{ calls: [plan(), navigate(), checkpoint('S1', 'blocked', '', 'Missing access'), browser('after')] }], { closeTab: 'ok', screenshots: 'ok', captureStarted: started, captureWait: wait });
  const running = env.run(); await captured; assert.equal(env.closeCalls.length, 0);
  const aborting = env.session.abort(); release(); await aborting; await running;
  assert.deepEqual(env.lifecycle, ['screenshot', 'close']);
  assert.equal(env.reports()[0].reported_verdict, 'blocked');
});

for (const closeTab of ['error', 'throw'] as const) test(`close ${closeTab} does not alter saved QA success or retry`, async t => {
  const env = await setup(t, [{ calls: [plan(), navigate(), checkpoint(), finish()] }], { closeTab });
  await env.run(); assert.equal(env.closeCalls.length, 1);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
  const events = readFileSync(join(env.dir, 'qa-diagnostics', env.reports()[0].run_id, 'events.jsonl'), 'utf8');
  assert.match(events, /tab_close_failed/); assert.equal(env.requests(), 1);
});

test('storage error still triggers close and blocks subsequent model tools', async t => {
  const env = await setup(t, [{ calls: [plan(), navigate(), browser('break-report'), checkpoint(), browser('after')] }], { closeTab: 'ok' });
  await env.run(); assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.deepEqual(env.actions, ['navigate', 'break-report']); assert.equal(env.requests(), 1);
});

test('successive runs each close only their own tracked tab once', async t => {
  const calls = () => [plan(), navigate(), checkpoint(), finish()];
  const env = await setup(t, [{ calls: calls() }, { calls: calls() }], { closeTab: 'ok' });
  await env.run(); await env.run(); assert.equal(env.closeCalls.length, 2);
  assert.equal(env.reports().length, 2); assert.deepEqual(env.extensionErrors, []);
});

test('graceful shutdown closes active QA tab once before settlement', async t => {
  let ready!: () => void; const second = new Promise<void>(resolve => { ready = resolve; });
  const env = await setup(t, [{ calls: [plan(), navigate()] }, { waitForAbort: true }], { closeTab: 'ok', onRequest: n => { if (n === 2) ready(); } });
  const running = env.run(); await second;
  await env.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  await env.session.abort(); await running;
  assert.equal(env.closeCalls.length, 1);
  assert.equal(env.reports()[0].execution_status, 'incomplete');
});

test('close-only Browse catalog needs no screenshot tool', async t => {
  const env = await setup(t, [{ calls: [plan(), navigate(), checkpoint(), finish()] }], { closeTab: 'ok' });
  await env.run();
  assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.equal(env.screenshotCalls.length, 0);
  assert.ok(!getCurrentTools(env.contexts[0].messages).some(tool => tool.name.endsWith('screenshot')));
  assert.equal(env.reports()[0].reported_verdict, 'passed');
});

test('standalone screenshots are denied during active QA work; checkpoint capture still runs', async t => {
  const env = await setup(t, [{ calls: [plan(), navigate(), screenshot(), browser('continue'), checkpoint(), screenshot(), finish()] }], { screenshots: 'ok' });
  await env.run();
  assert.deepEqual(env.screenshotCalls, [{ tab: 'chrome:7', format: 'png' }]);
  assert.deepEqual(env.actions, ['navigate', 'continue']);
  const denied = env.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'mcp__browse__screenshot');
  assert.equal(denied.length, 2);
  assert.ok(denied.every(m => m.role === 'toolResult' && m.isError));
  assert.ok(denied.every(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('qa_checkpoint')));
  assert.equal(env.reports()[0].reported_verdict, 'passed');
  assert.equal(env.reports()[0].progress.revision, 1);
  assert.deepEqual(env.extensionErrors, []);
});

test('nested model screenshot call cannot bypass checkpoint-only gate', async t => {
  const wrapped = call('mcp__browse__capture_via_wrapper', 'wrapped', {});
  const env = await setup(t, [{ calls: [plan(), navigate(), wrapped, checkpoint(), finish()] }], { screenshots: 'ok' });
  await env.run();
  assert.deepEqual(env.screenshotCalls, [{ tab: 'chrome:7', format: 'png' }]);
  const result = env.session.messages.find(m => m.role === 'toolResult' && m.toolName === wrapped.name);
  assert.ok(result?.role === 'toolResult' && result.isError);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
});

test('qa_finish schema requires only verdict; passed report uses checkpoint observations', async t => {
  const env = await setup(t, [{ calls: [plan(), browser('work'), checkpoint(), finish()] }]);
  await env.run();
  const tool = getCurrentTools(env.contexts[0].messages).find(tool => tool.name === 'qa_finish');
  const schema = tool?.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['verdict']);
  assert.equal('evidence' in schema.properties, false);
  assert.equal(env.reports()[0].evidence, 'S1: Value visible');
  assert.equal(env.reports()[0].reason, '');
  const result = env.session.messages.find(m => m.role === 'toolResult' && m.toolName === 'qa_finish');
  assert.ok(result?.role === 'toolResult' && !result.isError);
});

test('emergency blocked finish requires reason and never needs evidence', async t => {
  const env = await setup(t, [{ calls: [
    call('qa_finish', 'invalid-block', { verdict: 'blocked' }),
    call('qa_finish', 'valid-block', { verdict: 'blocked', reason: 'Essential credentials missing; no safe recovery available' }),
  ] }]);
  await env.run();
  assert.equal(env.reports()[0].reported_verdict, 'blocked');
  assert.equal(env.reports()[0].evidence, '');
  assert.match(env.reports()[0].reason, /credentials missing/);
});

test('plan and checkpoints return activated tasks without qa_execute_subtask round-trips', async t => {
  const env = await setup(t, [
    { calls: [plan(2)] },
    { calls: [browser('first'), checkpoint()] },
    { calls: [browser('second'), checkpoint('S2'), finish()] },
  ]);
  await env.run(); assert.equal(env.requests(), 3);
  const state = (index: number) => getCurrentSystemMessage(env.contexts[index].messages)?.sections?.qa_goal_guardian_progress ?? '';
  assert.match(state(1), /"stage":"executing"/); assert.match(state(1), /"subtask_id":"S1"/);
  assert.match(state(2), /"stage":"executing"/); assert.match(state(2), /"subtask_id":"S2"/);
  assert.match(state(2), /Action 2/); assert.doesNotMatch(state(2), /Action 1/);
  for (const context of env.contexts) assert.ok(!getCurrentTools(context.messages).some(tool => tool.name === 'qa_execute_subtask'));
  const results = env.session.messages.filter(m => m.role === 'toolResult');
  assert.ok(results.some(m => m.role === 'toolResult' && m.toolName === 'qa_plan' && JSON.stringify(m.content).includes('Action 1')));
  assert.ok(results.some(m => m.role === 'toolResult' && m.toolName === 'qa_checkpoint' && JSON.stringify(m.content).includes('Action 2')));
  assert.deepEqual(env.actions, ['first', 'second']);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
});

test('abort with a pending screenshot stops QA and preserves the saved checkpoint', async t => {
  let started!: () => void, release!: () => void, nextRequest!: () => void;
  const captured = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const continued = new Promise<void>(r => { nextRequest = r; });
  const env = await setup(t, [{ calls: [plan(2), navigate(), checkpoint()] }, { waitForAbort: true }], {
    screenshots: 'ok', captureStarted: started, captureWait: wait, closeTab: 'ok',
    onRequest: n => { if (n === 2) nextRequest(); },
  });
  const running = env.run(); await Promise.all([captured, continued]);
  assert.equal(env.reports()[0].active_subtask_id, 'S2');
  const aborting = env.session.abort(); release(); await aborting; await running;
  assert.equal(env.reports()[0].execution_status, 'aborted');
  assert.equal(env.reports()[0].subtask_results.length, 1);
  assert.deepEqual(env.actions, ['navigate']); assert.equal(env.closeCalls.length, 1);
});

test('tabs list with an unrelated tab never redirects checkpoint capture or terminal cleanup', async t => {
  const list = call('mcp__browse__tabs', 'list', { action: 'list', tab: 999 });
  const env = await setup(t, [{ calls: [plan(), navigate(), list, checkpoint(), finish()] }], { closeTab: 'ok', screenshots: 'ok' });
  await env.run();
  assert.deepEqual(env.screenshotCalls, [{ tab: 'chrome:7', format: 'png' }]);
  assert.deepEqual(env.closeCalls, [{ action: 'close', tab: 'chrome:7' }]);
  assert.equal(env.reports()[0].reported_verdict, 'passed');
});
