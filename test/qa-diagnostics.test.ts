import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { QaDiagnostics, findScreenshotTool, stripModelImages } from '../src/qa-diagnostics.ts';

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=';
const tools = [{ name: 'mcp__browse__screenshot', parameters: { type: 'object', properties: { tab: { type: 'string' }, format: { type: 'string' } }, required: ['tab'] } }];
function setup(t: TestContext) {
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  const diagnostics = new QaDiagnostics(dir, '00000000-0000-4000-8000-000000000001');
  t.after(async () => {
    await diagnostics.flushWrites();
    assert.equal(dirname(dir), process.cwd());
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir: join(dir, '00000000-0000-4000-8000-000000000001'), diagnostics };
}

test('discovers screenshot by live schema and refuses an ambiguous catalog', () => {
  assert.equal(findScreenshotTool(tools)?.name, 'mcp__browse__screenshot');
  assert.equal(findScreenshotTool([...tools, { ...tools[0], name: 'mcp__other_browse__screenshot' }]), undefined);
  assert.equal(findScreenshotTool([{ name: 'screenshot_diff', parameters: tools[0].parameters }]), undefined);
  assert.equal(findScreenshotTool([{ name: 'screenshot', parameters: { properties: { selector: {} } } }]), undefined);
});

test('uses the observed tab and strips the checkpoint image before its background save', async t => {
  const { dir, diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__execute', input: { tab: 'old' }, content: [{ type: 'text', text: '{"tab":"new"}' }], isError: false }, tools);
  const calls: unknown[] = [];
  const imagePath = join(dir, 'checkpoint-001.png');
  let writtenDuringCapture: boolean | undefined;
  await diagnostics.capture(1, 'checkpoint', {
    tools,
    async executeTool(name, args) {
      calls.push({ name, args });
      const filtered = diagnostics.observe({ toolName: name, input: args, parentToolCallId: 'checkpoint',
        content: [{ type: 'image', mimeType: 'image/png', data: png }], isError: false }, tools);
      writtenDuringCapture = existsSync(imagePath);
      assert.ok(filtered);
      assert.doesNotMatch(JSON.stringify(filtered), /iVBOR|image\/png/);
      return { isError: false };
    },
  });
  assert.deepEqual(calls, [{ name: 'mcp__browse__screenshot', args: { tab: 'new', format: 'png' } }]);
  assert.equal(writtenDuringCapture, false);
  await diagnostics.flushWrites();
  assert.deepEqual(readFileSync(imagePath), Buffer.from(png, 'base64'));
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.png')).length, 1);
});

test('capture failure is nonfatal, logged separately, and never retried', async t => {
  const { dir, diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__click', input: { tab: 'chosen' }, content: [], isError: false }, tools);
  let attempts = 0;
  await diagnostics.capture(2, 'checkpoint', { tools, async executeTool() { attempts++; return { isError: true }; } });
  assert.equal(attempts, 1);
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /capture_failed/);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.png')).length, 0);
});

test('a late screenshot result cannot replace the current browser tab', async t => {
  const { diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__navigate', input: { tab: 'first' }, content: [], isError: false }, tools);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = diagnostics.capture(1, 'first', {
    tools,
    async executeTool(toolName, input) {
      await wait;
      diagnostics.observe({ toolName, input, parentToolCallId: 'first', content: [], isError: false }, tools);
      return { isError: false };
    },
  });
  diagnostics.observe({ toolName: 'mcp__browse__navigate', input: { tab: 'second' }, content: [], isError: false }, tools);
  release();
  await first;
  const tabs: unknown[] = [];
  await diagnostics.capture(2, 'second', {
    tools,
    async executeTool(_name, input) { tabs.push(input.tab); return { isError: false }; },
  });
  assert.deepEqual(tabs, ['second']);
});

test('a failed background write is logged without overwriting an existing image', async t => {
  const { dir, diagnostics } = setup(t);
  const imagePath = join(dir, 'tool-001.png');
  mkdirSync(dir, { recursive: true });
  writeFileSync(imagePath, 'existing image');
  diagnostics.observe({
    toolName: 'mcp__browse__execute', input: { tab: 'qa' }, isError: false,
    content: [{ type: 'image', mimeType: 'image/png', data: png }],
  }, tools);

  await diagnostics.flushWrites();
  assert.equal(readFileSync(imagePath, 'utf8'), 'existing image');
  assert.equal(JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8')).event, 'image_save_failed');
});

test('unknown target is not guessed and failed or foreign tool calls cannot replace it', async t => {
  const { diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__click', input: { tab: 'bad' }, content: [], isError: true }, tools);
  diagnostics.observe({ toolName: 'unrelated_execute', input: { tab: 'foreign' }, content: [], isError: false }, tools);
  let attempts = 0;
  await diagnostics.capture(1, 'checkpoint', { tools, async executeTool() { attempts++; return { isError: false }; } });
  assert.equal(attempts, 0);
});

test('old model image blocks are removed without deleting textual tool observations', () => {
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text: 'Submit is enabled' }, { type: 'image', mimeType: 'image/png', data: png }] }];
  const filtered = stripModelImages(messages);
  assert.deepEqual(filtered[0].content, [{ type: 'text', text: 'Submit is enabled' }]);
  assert.equal(messages[0].content.length, 2);
});

test('image-only historical messages retain a valid text placeholder', () => {
  const filtered = stripModelImages([{ role: 'user', content: [{ type: 'image', data: png, mimeType: 'image/png' }] }]);
  assert.equal(filtered[0].content.length, 1);
  assert.doesNotMatch(JSON.stringify(filtered), /iVBOR|image\/png/);
});

test('duplicate images in text and opaque metadata cannot bypass result filtering', t => {
  const { diagnostics } = setup(t);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const result = diagnostics.observe({
    toolName: 'mcp__browse__execute', input: { tab: '7' }, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ value: 'Submit enabled', media: [{ type: 'image', data: png, mimeType: 'image/png' }] }) }],
    details: circular, structuredContent: { media: [{ type: 'image', data: png, mimeType: 'image/png' }] },
  }, tools);
  assert.ok(result);
  assert.match(JSON.stringify(result), /Submit enabled/);
  assert.doesNotMatch(JSON.stringify(result), /iVBOR|image\/png/);
  assert.deepEqual(result.details, {});
});

test('textual DOM image descriptions without pixel data remain available', () => {
  const text = '{"type":"image","alt":"Company logo","selector":"img.logo"}';
  const messages = [{ role: 'toolResult', content: [{ type: 'text', text }] }];
  assert.equal(stripModelImages(messages)[0].content[0].text, text);
});

test('legacy string-content messages drop embedded data-image URIs before summarization', () => {
  const original = [{ role: 'user', content: 'Old diagnostic: data:image/png;base64,AAAA. Continue with the form.' }];
  const filtered = stripModelImages(original);
  assert.doesNotMatch(filtered[0].content, /data:image|base64,AAAA/);
  assert.match(filtered[0].content, /Continue with the form/);
  assert.match(original[0].content, /data:image/);
});

for (const action of [undefined, 'list']) test(`tabs list (${action ?? 'default'}) cannot reroute checkpoint screenshot`, async t => {
  const { diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__navigate', input: { tab: 'qa' }, content: [], isError: false }, tools);
  diagnostics.observe({ toolName: 'mcp__browse__tabs', input: { tab: 'foreign', ...(action ? { action } : {}) }, content: [{ type: 'text', text: '{"tab":"foreign"}' }], isError: false }, tools);
  const calls: unknown[] = [];
  await diagnostics.capture(1, 'checkpoint', { tools, async executeTool(_name, args) { calls.push(args); return { isError: false }; } });
  assert.deepEqual(calls, [{ tab: 'qa', format: 'png' }]);
});

test('tabs close invalidates its screenshot target instead of selecting a returned tab', async t => {
  const { diagnostics } = setup(t);
  diagnostics.observe({ toolName: 'mcp__browse__navigate', input: { tab: 'qa' }, content: [], isError: false }, tools);
  diagnostics.observe({ toolName: 'mcp__browse__tabs', input: { action: 'close', tab: 'qa' }, content: [{ type: 'text', text: '{"tab":"foreign"}' }], isError: false }, tools);
  let calls = 0;
  await diagnostics.capture(1, 'checkpoint', { tools, async executeTool() { calls++; return { isError: false }; } });
  assert.equal(calls, 0);
});
