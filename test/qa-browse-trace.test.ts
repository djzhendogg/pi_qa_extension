import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaBrowseTrace } from '../src/qa-browse-trace.ts';
import { outputTab } from '../src/qa-diagnostics.ts';

function observe(trace: QaBrowseTrace, name: string, input: Record<string, unknown>, text: string, isError = false): void {
  const event = { toolCallId: 'call', toolName: `mcp__browse__${name}`, input };
  trace.begin(event, []);
  trace.observe({ ...event, content: [{ type: 'text', text }], isError });
}

test('failed Browse calls stay in the trace for their own checkpoint', () => {
  const trace = new QaBrowseTrace();
  observe(trace, 'snapshot', { tab: 7 }, '{"tab":7,"url":"https://example.com/first"}');
  trace.finish();
  observe(trace, 'snapshot', { tab: 7 }, 'Snapshot timed out', true);
  const failed = trace.finish();
  assert.deepEqual(failed.browse_trace, [{
    tool: 'mcp__browse__snapshot', input: { tab: 7 }, status: 'error', result: 'Snapshot timed out',
  }]);
});

test('execute results can carry both snapshots and typed secrets are kept out of trace excerpts', () => {
  const trace = new QaBrowseTrace();
  const tab = 'chrome:7';
  const url = 'https://example.com/login';
  observe(trace, 'fill', { tab, ref: 'e12', value: 'fixture-secret' }, 'Filled e12 with fixture-secret');
  assert.doesNotMatch(JSON.stringify(trace.finish()), /fixture-secret/);
  observe(trace, 'execute', { tab, code: 'const before = await snapshot(); await ref("e3").click(); return { dom_before: before, dom_after: await snapshot() };' },
    `Tab: ${tab}\n${JSON.stringify({ url, url_before: url, dom_before: 'Before save', dom_after: 'After save' })}`);
  const evidence = trace.finish();
  assert.match(evidence.browse_trace[0].result ?? '', /After save/);
  assert.equal(evidence.browse_trace[0].input.actions, 'snapshot → click → snapshot');
  assert.doesNotMatch(JSON.stringify(evidence.browse_trace[0].input), /const before/);
});

for (const variant of ['array', 'single block'] as const) test(`Browse metadata is read from an MCP envelope with ${variant} content`, () => {
  const trace = new QaBrowseTrace();
  const tab = 'chrome:7';
  const url_before = 'https://example.com/form';
  const url_after = 'https://example.com/saved';
  const payload = { tab, result: { url_before, url_after } };
  const block = { type: 'text', text: JSON.stringify(payload) };
  const envelope = { content: variant === 'array' ? [block] : block, isError: false };
  const event = { toolCallId: 'call', toolName: 'mcp__browse__execute', input: {},
    content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: false };
  trace.begin(event, []);
  trace.observe(event);
  const evidence = trace.finish();
  assert.equal(outputTab(event), tab);
  assert.deepEqual(JSON.parse(evidence.browse_trace[0].result!), payload);
});
