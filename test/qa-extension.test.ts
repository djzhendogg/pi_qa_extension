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
const finish = (id = 'finish'): ToolCall => ({ type: 'toolCall', id, name: 'qa_finish', arguments: { verdict: 'passed', evidence: 'Success toast observed', reason: '' } });
const browser = (id: string): ToolCall => ({ type: 'toolCall', id, name: 'browser_execute', arguments: { action: id } });
const checkpoint = (id: string, completed: string[], objective: string): ToolCall => ({
  type: 'toolCall', id, name: 'qa_checkpoint', arguments: { completed, current_objective: objective },
});
type Reply = { calls?: ToolCall[]; stopReason?: Exclude<AssistantMessage['stopReason'], 'pending'>; errorMessage?: string; waitForAbort?: boolean; usageInput?: number };

async function setup(t: TestContext, replies: Reply[], options: { brokenOutput?: boolean; startupCase?: boolean; invalidCase?: boolean; fromDisk?: boolean; compaction?: boolean; retry?: boolean; compactionFixture?: boolean; screenshots?: 'ok' | 'error' | 'bad-storage' } = {}) {
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  const casePath = join(dir, 'case with spaces.json');
  writeFileSync(casePath, JSON.stringify({ id: 'TC-001', url: 'https://example.com', task: 'Create the item exactly once', expected: options.invalidCase ? '' : 'The item exists' }));
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
  if (options.startupCase) loader.getExtensions().runtime.flagValues.set('qa-case', casePath);
  if (options.brokenOutput) {
    const file = join(dir, 'occupied');
    writeFileSync(file, 'not a directory');
    loader.getExtensions().runtime.flagValues.set('qa-results-dir', file);
  }
  const actions: string[] = [];
  const screenshotCalls: unknown[] = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=';
  const customTools: ToolDefinition[] = [defineTool({
    name: 'browser_execute', label: 'browser', description: 'Test browser side effect',
    parameters: Type.Object({ action: Type.String() }),
    async execute(_id, params) {
      if (params.action === 'error') throw new Error('Browser disconnected');
      actions.push(params.action);
      return { content: [{ type: 'text', text: 'Observed page' }], details: {} };
    },
  })];
  if (options.screenshots) {
    customTools.push(defineTool({
      name: 'mcp__browse__navigate', label: 'Navigate', description: 'Browse navigation fixture',
      parameters: Type.Object({ tab: Type.String() }),
      async execute(_id, params) {
        actions.push('navigate');
        return { content: [{ type: 'text', text: JSON.stringify({ tab: params.tab }) }], details: {} };
      },
    }), defineTool({
      name: 'mcp__browse__screenshot', label: 'Screenshot', description: 'Capture the tab as an image',
      parameters: Type.Object({ tab: Type.String(), format: Type.Optional(Type.Literal('png')) }),
      async execute(_id, params) {
        screenshotCalls.push(params);
        if (options.screenshots === 'error') throw new Error('Screenshot backend unavailable');
        return {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          details: { duplicateImage: { type: 'image', data: png, mimeType: 'image/png' } },
          structuredContent: { media: [{ type: 'image', data: png, mimeType: 'image/png' }] },
        };
      },
    }));
    if (options.screenshots === 'bad-storage') {
      writeFileSync(join(dir, 'qa-diagnostics'), 'not a directory');
    }
  }
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
    session, dir, actions, contexts, extensionErrors, whenRequested, screenshotCalls,
    requests: () => requests,
    compactions: () => compactions,
    async run() {
      if (options.startupCase) await session.prompt('Execute QA case');
      else {
        // sendUserMessage intentionally schedules asynchronously. The command can
        // return before Pi marks the run busy; wait for its actual settlement event.
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = session.subscribe(event => {
            if (event.type === 'agent_settled') { unsubscribe(); resolve(); }
          });
          void session.prompt(`/qa-run "${casePath}"`).catch(error => { unsubscribe(); reject(error); });
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

for (const [name, calls, expectedActions] of [
  ['finish alone', [finish()], []],
  ['finish then browser', [finish(), browser('after')], []],
  ['browser then finish then browser', [browser('before'), finish(), browser('after')], ['before']],
  ['duplicate finish', [finish('first'), finish('second')], []],
] as const) {
  test(`${name}: preserves tool results and sends no further provider request`, async t => {
    const env = await setup(t, [{ calls: [...calls] }]);
    await env.run();
    assert.deepEqual(env.actions, expectedActions);
    assert.equal(env.requests(), 1);
    const [report] = env.reports();
    assert.equal(report.execution_status, 'completed');
    assert.equal(report.reported_verdict, 'passed');
    assert.equal(report.verified_verdict, null);
    assert.equal(report.telemetry.llm_calls, 1);
    const results = env.session.messages.filter(m => m.role === 'toolResult');
    assert.equal(results.length, calls.length);
    assert.deepEqual(env.extensionErrors, []);
  });
}

test('browser results remain the latest messages and QA case stays in stable system context', async t => {
  const env = await setup(t, [{ calls: [browser('open')] }, { calls: [browser('error')] }, { calls: [finish()] }], { startupCase: true });
  await env.run();
  assert.equal(env.requests(), 3);
  const systemPrompt = getCurrentSystemPrompt(env.contexts[0].messages);
  assert.match(systemPrompt, /Create the item exactly once/);
  assert.match(systemPrompt, /The item exists/);
  assert.doesNotMatch(systemPrompt, /No independently verified progress|Your evidence is unverified/);
  for (const [index, context] of env.contexts.entries()) {
    assert.equal(getCurrentSystemPrompt(context.messages), systemPrompt);
    assert.equal(context.messages.filter(m => m.role === 'user').length, 1);
    if (index > 0) assert.equal(context.messages.at(-1)?.role, 'toolResult');
  }
  assert.equal(env.reports()[0].telemetry.tool_errors, 1);
});

test('invalid finish does not close gate or prevent subsequent legitimate work', async t => {
  const invalid = finish();
  invalid.arguments.evidence = ' ';
  const env = await setup(t, [{ calls: [invalid, browser('recover')] }, { calls: [finish('valid')] }]);
  await env.run();
  assert.deepEqual(env.actions, ['recover']);
  assert.equal(env.reports()[0].execution_status, 'completed');
  assert.equal(env.requests(), 2);
});

for (const [stopReason, status] of [['stop', 'incomplete'], ['error', 'error'], ['aborted', 'aborted']] as const) {
  test(`settlement with ${stopReason} writes ${status} without a QA verdict`, async t => {
    const env = await setup(t, [{ stopReason, errorMessage: stopReason === 'error' ? 'Inference unavailable' : undefined }]);
    await env.run();
    const [report] = env.reports();
    assert.equal(report.execution_status, status);
    assert.equal(report.reported_verdict, null);
  });
}

test('report write failure stops further tools and model requests', async t => {
  const env = await setup(t, [{ calls: [browser('before'), finish(), browser('after')] }], { brokenOutput: true });
  await env.run();
  assert.deepEqual(env.actions, ['before']);
  assert.equal(env.requests(), 1);
  const results = env.session.messages.filter(m => m.role === 'toolResult');
  assert.ok(results.some(result => result.role === 'toolResult' && result.toolName === 'qa_finish' && result.isError));
});

test('entry point loads from disk in Pi and can finish a case', async t => {
  const env = await setup(t, [{ calls: [finish()] }], { fromDisk: true, startupCase: true });
  await env.run();
  assert.equal(env.reports()[0].execution_status, 'completed');
  assert.deepEqual(env.extensionErrors, []);
});

test('two explicit runs have independent reports and counters', async t => {
  const env = await setup(t, [{ calls: [finish('first')] }, { calls: [finish('second')] }]);
  await env.run();
  await env.run();
  assert.equal(env.requests(), 2);
  const reports = env.reports();
  assert.equal(reports.length, 2);
  assert.notEqual(reports[0].run_id, reports[1].run_id);
  assert.ok(reports.every(r => r.execution_status === 'completed' && r.telemetry.llm_calls === 1));
});

test('completed case blocks a later prompt and malformed replacement does not reopen it', async t => {
  const env = await setup(t, [{ calls: [finish()] }, { calls: [browser('must-not-run')] }]);
  await env.run();
  await env.session.prompt('/qa-run missing-case.json');
  await env.session.prompt('Continue creating items');
  await env.session.waitForIdle();
  assert.equal(env.requests(), 1);
  assert.deepEqual(env.actions, []);
  assert.equal(env.reports().length, 1);
  assert.equal(env.reports()[0].execution_status, 'completed');
});

test('invalid --qa-case fails closed before any provider or browser request', async t => {
  const env = await setup(t, [{ calls: [browser('must-not-run')] }], { startupCase: true, invalidCase: true });
  await env.run();
  assert.equal(env.requests(), 0);
  assert.deepEqual(env.actions, []);
});

test('real user abort during a request produces an aborted report', { timeout: 10000 }, async t => {
  const env = await setup(t, [{ waitForAbort: true }]);
  const running = env.run();
  await env.whenRequested;
  await env.session.abort();
  await running;
  assert.equal(env.reports()[0].execution_status, 'aborted');
  assert.equal(env.reports()[0].reported_verdict, null);
});

test('reload finalizes a loaded unstarted case and does not silently resume it', async t => {
  const env = await setup(t, [], { startupCase: true });
  await env.session.reload();
  assert.equal(env.reports()[0].execution_status, 'incomplete');
  await env.session.prompt('A normal Pi prompt');
  assert.equal(env.reports().length, 1);
  assert.equal(env.requests(), 1);
});

test('terminal case cancels manual compaction before a summarization request', async t => {
  const env = await setup(t, [{ calls: [browser('inspect')] }, { calls: [finish()] }], { compaction: true });
  await env.run();
  await assert.rejects(env.session.compact(), /cancelled/i);
  assert.equal(env.requests(), 2);
});

test('terminal case stops scheduled cache warming without emitting swallowed provider-hook errors', async t => {
  const env = await setup(t, [{ calls: [finish()] }]);
  await env.run();
  const action = await env.session.extensionRunner.emitCacheWarmingDecision({
    type: 'cache_warming_decision', action: 'warm', warmCost: 0, missCost: 1, continuationProbability: 1,
  });
  assert.equal(action, 'stop');
  await env.session.extensionRunner.emitBeforeProviderRequest({ late: true });
  assert.deepEqual(env.extensionErrors, []);
  assert.equal(env.requests(), 1);
});

test('Pi automatic retry can recover and finish without an intermediate incomplete report', async t => {
  const env = await setup(t, [{ stopReason: 'error', errorMessage: '503 Service Unavailable' }, { calls: [finish()] }], { retry: true });
  await env.run();
  assert.equal(env.requests(), 2);
  const reports = env.reports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].execution_status, 'completed');
  assert.equal(reports[0].telemetry.llm_calls, 2);
});

test('checkpoint updates the current objective in system context without injecting user messages', async t => {
  const env = await setup(t, [
    { calls: [browser('open')] },
    { calls: [checkpoint('opened', ['Form opened'], 'Fill required fields')] },
    { calls: [browser('fill')] },
    { calls: [checkpoint('filled', ['Form opened', 'Required fields filled'], 'Submit and observe result')] },
    { calls: [finish()] },
  ]);
  await env.run();
  assert.equal(env.requests(), 5);
  const progress = env.contexts.map(context => getCurrentSystemMessage(context.messages)?.sections?.qa_goal_guardian_progress);
  assert.equal(progress[0], undefined);
  assert.equal(progress[1], undefined);
  assert.match(progress[2] ?? '', /Fill required fields/);
  assert.equal(progress[2], progress[3]);
  assert.match(progress[4] ?? '', /Submit and observe result/);
  assert.doesNotMatch(progress[4] ?? '', /Fill required fields/);
  for (const [index, context] of env.contexts.entries()) {
    assert.equal(context.messages.filter(m => m.role === 'user').length, 1);
    if (index > 0) assert.equal(context.messages.at(-1)?.role, 'toolResult');
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), ['browser_execute', 'qa_checkpoint', 'qa_finish']);
  }
  const [report] = env.reports();
  assert.equal(report.progress.revision, 2);
  assert.equal(report.progress.source, 'agent_reported');
  assert.equal(report.progress.current_objective, 'Submit and observe result');
  assert.equal(report.verified_verdict, null);
  assert.deepEqual(env.actions, ['open', 'fill']);
});

test('terminal finish blocks a later checkpoint as well as browser actions', async t => {
  const env = await setup(t, [{ calls: [finish(), checkpoint('too-late', [], 'Restart'), browser('too-late')] }]);
  await env.run();
  const [report] = env.reports();
  assert.equal(report.execution_status, 'completed');
  assert.equal(report.progress, null);
  assert.equal(report.telemetry.blocked_tool_calls, 2);
  assert.deepEqual(env.actions, []);
});

test('progress and original case survive automatic history compaction', async t => {
  const env = await setup(t, [
    { calls: [checkpoint('saved', ['Form filled'], 'Submit without restarting')], usageInput: 128000 },
    { calls: [finish()] },
  ], { compaction: true, compactionFixture: true });
  await env.run();
  assert.ok(env.compactions() >= 1);
  assert.equal(env.requests(), 2);
  const context = env.contexts[1];
  assert.match(getCurrentSystemPrompt(context.messages), /Create the item exactly once/);
  assert.match(getCurrentSystemPrompt(context.messages), /Submit without restarting/);
  assert.equal(env.reports()[0].progress.revision, 1);
  assert.deepEqual(env.extensionErrors, []);
});

test('a new case starts without progress from the previous case', async t => {
  const env = await setup(t, [
    { calls: [checkpoint('saved', ['Form opened'], 'Fill fields')] },
    { calls: [finish('first')] }, { calls: [finish('second')] },
  ]);
  await env.run();
  await env.run();
  assert.equal(env.requests(), 3);
  assert.equal(getCurrentSystemMessage(env.contexts[2].messages)?.sections?.qa_goal_guardian_progress, undefined);
  const reports = env.reports();
  assert.equal(reports.length, 2);
  assert.equal(reports.filter(report => report.progress === null).length, 1);
});

test('invalid checkpoint remains recoverable and preserves browser execution', async t => {
  const env = await setup(t, [
    { calls: [checkpoint('invalid', [], ' '), browser('recover')] }, { calls: [finish()] },
  ]);
  await env.run();
  assert.deepEqual(env.actions, ['recover']);
  assert.equal(env.reports()[0].progress, null);
  assert.equal(env.reports()[0].execution_status, 'completed');
});

test('checkpoint storage failure closes gate before later browser operations', async t => {
  const env = await setup(t, [{ calls: [checkpoint('saved', ['Form opened'], 'Fill fields'), browser('after')] }], { brokenOutput: true });
  await env.run();
  assert.equal(env.requests(), 1);
  assert.deepEqual(env.actions, []);
  assert.ok(env.session.messages.some(m => m.role === 'toolResult' && m.toolName === 'qa_checkpoint' && m.isError));
});

test('checkpoint captures Browse PNG for humans, without image bytes or paths in model input/report', async t => {
  const env = await setup(t, [
    { calls: [{ type: 'toolCall', id: 'navigate', name: 'mcp__browse__navigate', arguments: { tab: 'chrome:7' } }] },
    { calls: [checkpoint('capture', ['Form filled'], 'Submit the form')] },
    { calls: [finish()] },
  ], { screenshots: 'ok' });
  await env.run();
  assert.deepEqual(env.screenshotCalls, [{ tab: 'chrome:7', format: 'png' }]);
  const [report] = env.reports();
  assert.ok(readFileSync(join(env.dir, 'qa-diagnostics', report.run_id, 'checkpoint-001.png')).length > 0);
  assert.equal(report.execution_status, 'completed');
  const requestText = JSON.stringify(env.contexts);
  assert.doesNotMatch(requestText, /iVBOR|image\/png|qa-diagnostics|checkpoint-001\.png/);
  assert.doesNotMatch(JSON.stringify(report), /iVBOR|image\/png|qa-diagnostics|checkpoint-001\.png/);
  assert.doesNotMatch(JSON.stringify(env.session.messages), /iVBOR|image\/png/);
  assert.equal(env.requests(), 3);
  assert.deepEqual(env.extensionErrors, []);
});

for (const failure of ['error', 'bad-storage'] as const) {
  test(`diagnostic screenshot ${failure} is nonfatal and does not retry`, async t => {
    const env = await setup(t, [
      { calls: [{ type: 'toolCall', id: 'navigate', name: 'mcp__browse__navigate', arguments: { tab: 'chrome:7' } }] },
      { calls: [checkpoint('capture', ['Form filled'], 'Submit the form')] },
      { calls: [finish()] },
    ], { screenshots: failure });
    await env.run();
    assert.equal(env.screenshotCalls.length, 1);
    assert.equal(env.reports()[0].execution_status, 'completed');
    assert.doesNotMatch(JSON.stringify(env.contexts), /iVBOR|image\/png/);
  });
}

test('invalid checkpoint and finish do not trigger diagnostic screenshots', async t => {
  const env = await setup(t, [
    { calls: [{ type: 'toolCall', id: 'navigate', name: 'mcp__browse__navigate', arguments: { tab: 'chrome:7' } }] },
    { calls: [checkpoint('invalid', [], ' ')] }, { calls: [finish()] },
  ], { screenshots: 'ok' });
  await env.run();
  assert.equal(env.screenshotCalls.length, 0);
  assert.equal(existsSync(join(env.dir, 'qa-diagnostics')), false);
});
