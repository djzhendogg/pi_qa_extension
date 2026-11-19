import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentSession, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model, type ToolCall, type Context, type TranscriptContext, type Api, type SimpleStreamOptions } from '@earendil-works/pi-ai';
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
type Reply = { calls?: ToolCall[]; stopReason?: Exclude<AssistantMessage['stopReason'], 'pending'>; errorMessage?: string; waitForAbort?: boolean };

async function setup(t: TestContext, replies: Reply[], options: { brokenOutput?: boolean; startupCase?: boolean; invalidCase?: boolean; fromDisk?: boolean; compaction?: boolean; retry?: boolean } = {}) {
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  const casePath = join(dir, 'case with spaces.json');
  writeFileSync(casePath, JSON.stringify({ id: 'TC-001', url: 'https://example.com', task: 'Create the item exactly once', expected: options.invalidCase ? '' : 'The item exists' }));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false, keepRecentTokens: 1, reserveTokens: 32 },
    retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 }, packages: [],
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: options.fromDisk ? [] : [qaExtension],
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
  const customTools = [defineTool({
    name: 'browser_execute', label: 'browser', description: 'Test browser side effect',
    parameters: Type.Object({ action: Type.String() }),
    async execute(_id, params) {
      if (params.action === 'error') throw new Error('Browser disconnected');
      actions.push(params.action);
      return { content: [{ type: 'text', text: 'Observed page' }], details: {} };
    },
  })];
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
        usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
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
    session, dir, actions, contexts, extensionErrors, whenRequested,
    requests: () => requests,
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

test('anchor stays transient across calls and tool errors are counted', async t => {
  const env = await setup(t, [{ calls: [browser('error')] }, { calls: [finish()] }], { startupCase: true });
  await env.run();
  assert.equal(env.requests(), 2);
  for (const context of env.contexts) {
    const text = JSON.stringify(context.messages);
    assert.equal(text.split('QA EXECUTION STATE').length - 1, 1);
    assert.match(text, /Create the item exactly once/);
  }
  assert.doesNotMatch(JSON.stringify(env.session.messages), /QA EXECUTION STATE/);
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
