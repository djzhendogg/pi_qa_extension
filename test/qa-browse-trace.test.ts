import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaBrowseTrace } from '../src/qa-browse-trace.ts';

function observe(trace: QaBrowseTrace, name: string, input: Record<string, unknown>, text: string, isError = false): void {
  const event = { toolCallId: 'call', toolName: `mcp__browse__${name}`, input };
  trace.begin(event, []);
  trace.observe({ ...event, content: [{ type: 'text', text }], isError });
}

test('URLs stay scoped to their tabs and a failed snapshot cannot supply an after URL', () => {
  const trace = new QaBrowseTrace();
  observe(trace, 'snapshot', { tab: 7 }, '{"tab":7,"url":"https://example.com/first"}');
  trace.finish();
  observe(trace, 'snapshot', { tab: 8 }, '{"tab":8,"url":"https://example.com/second"}');
  const otherTab = trace.finish();
  assert.equal(otherTab.url_before, 'https://example.com/second');
  observe(trace, 'snapshot', { tab: 7 }, 'Snapshot timed out', true);
  const failed = trace.finish();
  assert.equal(failed.url_before, 'https://example.com/first');
  assert.equal(failed.url_after, 'https://example.com/first'); // A read-only failure preserves the last known URL.
  assert.equal(failed.browse_trace[0].status, 'error');
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

test('a URL-only observation can establish the starting URL without supplying DOM', () => {
  const trace = new QaBrowseTrace();
  observe(trace, 'execute', { tab: 7, code: 'return page.url()' }, 'Tab: 7\nhttps://example.com/start');
  observe(trace, 'navigate', { tab: 7, url: 'https://example.com/requested' },
    '{"tab":7,"url":"https://example.com/redirected"}');
  const evidence = trace.finish();
  assert.equal(evidence.url_before, 'https://example.com/start');
  assert.equal(evidence.url_after, 'https://example.com/redirected');
});
