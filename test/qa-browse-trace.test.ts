import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaBrowseTrace } from '../src/qa-browse-trace.ts';

function observe(trace: QaBrowseTrace, name: string, input: Record<string, unknown>, text: string, isError = false): void {
  const event = { toolCallId: 'call', toolName: `mcp__browse__${name}`, input };
  trace.begin(event, []);
  trace.observe({ ...event, content: [{ type: 'text', text }], isError });
}

test('DOM stays scoped to its tab and a failed snapshot cannot supply fresh evidence', () => {
  const trace = new QaBrowseTrace();
  observe(trace, 'snapshot', { tab: 7 }, 'Existing state of tab 7');
  trace.finish(null, null);
  observe(trace, 'snapshot', { tab: 8 }, 'Existing state of tab 8');
  const otherTab = trace.finish(null, null);
  assert.equal(otherTab.dom_before?.text, 'Existing state of tab 8');
  observe(trace, 'snapshot', { tab: 7 }, 'Snapshot timed out', true);
  const failed = trace.finish(null, null);
  assert.equal(failed.dom_before?.text, 'Existing state of tab 7');
  assert.equal(failed.dom_after, null);
});

test('execute results can carry both snapshots and typed secrets are kept out of trace excerpts', () => {
  const trace = new QaBrowseTrace();
  const tab = 'chrome:7';
  const url = 'https://example.com/login';
  observe(trace, 'fill', { tab, ref: 'e12', value: 'fixture-secret' }, 'Filled e12 with fixture-secret');
  assert.doesNotMatch(JSON.stringify(trace.finish(null, null)), /fixture-secret/);
  observe(trace, 'execute', { tab, code: 'const before = await snapshot(); await ref("e3").click(); return { dom_before: before, dom_after: await snapshot() };' },
    `Tab: ${tab}\n${JSON.stringify({ url, url_before: url, dom_before: 'Before save', dom_after: 'After save' })}`);
  const evidence = trace.finish(url, url);
  assert.deepEqual(evidence.dom_before, { tab, url, text: 'Before save' });
  assert.deepEqual(evidence.dom_after, { tab, url, text: 'After save' });
  assert.equal(evidence.browse_trace[0].input.actions, 'snapshot → click → snapshot');
  assert.doesNotMatch(JSON.stringify(evidence.browse_trace[0].input), /const before/);
});
