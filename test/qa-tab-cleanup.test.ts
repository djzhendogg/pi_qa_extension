import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaTabCleanup } from '../src/qa-tab-cleanup.ts';
const closeTool = { name: 'mcp__browse__close', parameters: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] } };
const tools = [closeTool];
const observed = (toolName = 'mcp__browse__navigate', tab = 'qa:7', isError = false) => ({ toolName, input: { tab }, content: [], isError });

test('closes latest successful QA tab once, with scoped internal authorization and fresh signal', async () => {
  const log: string[] = []; const cleanup = new QaTabCleanup((event) => log.push(event));
  cleanup.observe(observed(), tools);
  cleanup.observe({ ...observed('mcp__browse__execute', 'stale'), content: [{ type: 'text', text: '{"tab":"actual"}' }] }, tools);
  cleanup.observe(observed('mcp__unrelated__navigate', 'foreign'), tools);
  cleanup.observe(observed('mcp__browse__navigate', 'failed', true), tools);
  let calls = 0;
  const ctx = { tools, async executeTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    calls++; assert.equal(name, closeTool.name); assert.deepEqual(args, { tab: 'actual' });
    assert.equal(options?.signal?.aborted, false);
    assert.equal(cleanup.allowsClose({ toolName: name, parentToolCallId: 'finish', input: args }), true);
    assert.equal(cleanup.allowsClose({ toolName: name, input: args }), false);
    assert.equal(cleanup.allowsClose({ toolName: name, parentToolCallId: 'other', input: args }), false);
    assert.equal(cleanup.allowsClose({ toolName: name, parentToolCallId: 'finish', input: { tab: 'foreign' } }), false);
    assert.equal(cleanup.allowsClose({ toolName: 'mcp__browse__navigate', parentToolCallId: 'finish', input: args }), false);
    return { isError: false };
  } };
  await Promise.all([cleanup.close('finish', ctx), cleanup.close('again', ctx)]);
  await cleanup.close('third', ctx);
  assert.equal(calls, 1); assert.deepEqual(log, ['tab_close_succeeded']);
  assert.equal(cleanup.allowsClose({ toolName: closeTool.name, parentToolCallId: 'finish', input: { tab: 'actual' } }), false);
});

test('unknown targets, ambiguous tools and unsafe required arguments are skipped', async () => {
  let calls = 0;
  for (const catalog of [[], tools, [...tools, { ...closeTool, name: 'mcp__second__close' }], [{ ...closeTool, parameters: { ...closeTool.parameters, required: ['tab', 'browser'] } }]]) {
    const cleanup = new QaTabCleanup(() => {});
    if (catalog !== tools) cleanup.observe(observed(), catalog);
    await cleanup.close('end', { tools: catalog, async executeTool() { calls++; return { isError: false }; } });
  }
  assert.equal(calls, 0);
});

for (const failure of ['throw', 'result']) test(`close ${failure} is logged, never retried or thrown`, async () => {
  const log: string[] = []; const cleanup = new QaTabCleanup(event => log.push(event));
  cleanup.observe(observed(), tools); let calls = 0;
  const ctx = { tools, async executeTool() { calls++; if (failure === 'throw') throw new Error('Disconnected'); return { isError: true }; } };
  await cleanup.close('end', ctx); await cleanup.close('retry', ctx);
  assert.equal(calls, 1); assert.deepEqual(log, ['tab_close_failed']);
});

test('model already closing the tracked tab prevents a second close', async () => {
  const cleanup = new QaTabCleanup(() => {}); cleanup.observe(observed(), tools);
  cleanup.observe(observed(closeTool.name), tools); let calls = 0;
  await cleanup.close('end', { tools, async executeTool() { calls++; return { isError: false }; } });
  assert.equal(calls, 0);
});

for (const closed of ['qa:7', 'foreign']) test(`successful close uses requested tab, not returned active tab (${closed})`, async () => {
  const cleanup = new QaTabCleanup(() => {});
  cleanup.observe(observed(), tools);
  cleanup.observe({ ...observed(closeTool.name, closed), content: [{ type: 'text', text: JSON.stringify({ tab: closed === 'qa:7' ? 'next' : 'qa:7' }) }] }, tools);
  const calls: unknown[] = [];
  await cleanup.close('end', { tools, async executeTool(_name, args) { calls.push(args); return { isError: false }; } });
  assert.deepEqual(calls, closed === 'qa:7' ? [] : [{ tab: 'qa:7' }]);
});
