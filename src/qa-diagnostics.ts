import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CatalogTool { name: string; parameters: unknown }
interface Block { type: string; text?: string; data?: string; mimeType?: string }
export interface Observation {
  toolName: string;
  input: Record<string, unknown>;
  content: readonly Block[];
  isError: boolean;
  parentToolCallId?: string;
  details?: unknown;
  structuredContent?: unknown;
}
export interface CaptureContext {
  tools: readonly CatalogTool[];
  executeTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ isError: boolean }>;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isScreenshot = (name: string) => /(?:^|[_:.-])screenshot$/.test(name);
const validTab = (value: unknown): value is string | number =>
  (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/** Browse's published plain screenshot tool requires tab; inspect the live schema. */
export function findScreenshotTool(tools: readonly CatalogTool[]): CatalogTool | undefined {
  const candidates = tools.filter(tool => {
    const schema = object(tool.parameters);
    return isScreenshot(tool.name) && object(schema?.properties)?.tab !== undefined &&
      Array.isArray(schema?.required) && schema.required.includes('tab');
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function sameNamespace(name: string, reference: string, operation = 'screenshot'): boolean {
  const prefix = reference.slice(0, -operation.length);
  return prefix ? name.startsWith(prefix) : ['execute', 'navigate', 'click', 'fill', 'type', 'press', 'select', 'hover', 'drag', 'scroll', 'wait_for', 'snapshot', 'screenshot', 'tabs', 'eval', 'close', 'close_tab', 'tab_close'].includes(name);
}

export function outputTab(event: Observation): string | number | undefined {
  const structured = object(event.structuredContent);
  if (validTab(structured?.tab)) return structured.tab;
  for (const block of event.content) {
    if (block.type !== 'text' || !block.text) continue;
    try {
      const parsed = object(JSON.parse(block.text));
      if (validTab(parsed?.tab)) return parsed.tab;
    } catch { /* Browse can also return a plain protocol header. */ }
    const header = /^(?:Tab:\s*|tab=)([^\s,]+)/i.exec(block.text);
    if (header) {
      const value = /^\d+$/.test(header[1]) ? Number(header[1]) : header[1];
      if (validTab(value)) return value;
    }
  }
  return validTab(event.input.tab) ? event.input.tab : undefined;
}

function withoutInlineImages(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[nested data omitted]';
  if (typeof value === 'string') return value.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]');
  if (Array.isArray(value)) return value.map(item => withoutInlineImages(item, depth + 1));
  const record = object(value);
  if (!record) return value;
  const imageType = record.type === 'image' || (typeof (record.mimeType ?? record.mime_type) === 'string' && String(record.mimeType ?? record.mime_type).startsWith('image/'));
  if (imageType && typeof record.data === 'string') return '[image omitted]';
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutInlineImages(item, depth + 1)]));
}

function cleanText(text: string, images: readonly Block[]): string {
  let cleaned = text;
  for (const image of images) if (image.data) cleaned = cleaned.split(image.data).join('[image omitted]');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    const stripped = withoutInlineImages(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(stripped)) return JSON.stringify(stripped);
  } catch { /* Keep non-JSON DOM observations as text. */ }
  return String(withoutInlineImages(cleaned));
}

/** Final model-boundary protection, including images already present in old history. */
export function stripModelImages<T>(messages: readonly T[]): T[] {
  return messages.map(message => {
    const original = object(message);
    if (typeof original?.content === 'string') {
      const content = cleanText(original.content, []);
      return content === original.content ? message : { ...message, content };
    }
    if (!original || !Array.isArray(original.content)) return message;
    const images = original.content.filter(block => object(block)?.type === 'image') as Block[];
    let changed = images.length > 0;
    const content = original.content.filter(block => object(block)?.type !== 'image').map(block => {
      if (object(block)?.type !== 'text' || typeof block.text !== 'string') return block;
      const text = cleanText(block.text, images);
      changed ||= text !== block.text;
      return text === block.text ? block : { ...block, text };
    });
    if (!changed) return message;
    return { ...message, content: content.length ? content : [{ type: 'text', text: '[Image omitted for non-visual QA model]' }] };
  });
}

/** Human artifacts only. Never add these paths or bytes to QaRun/report state. */
export class QaDiagnostics {
  readonly directory: string;
  private target: { tool: string; tab: string | number } | undefined;
  private imageSequence = 0;
  private pending = new Map<string, { revision: number; saved: boolean; tool: string }>();

  constructor(directory: string, runId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('Invalid diagnostics run id');
    this.directory = resolve(directory, runId);
  }

  /** Pi supplies parentToolCallId for internal calls; model arguments cannot set it. */
  allowsCapture(event: { toolName: string; parentToolCallId?: string }): boolean {
    return event.parentToolCallId !== undefined &&
      this.pending.get(event.parentToolCallId)?.tool === event.toolName;
  }

  log(event: string, reason: string): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(join(this.directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, reason: reason.slice(0, 1000) }) + '\n');
    } catch { /* Diagnostics failures must never fail the QA case. */ }
  }

  observe(event: Observation, tools: readonly CatalogTool[]) {
    const screenshot = findScreenshotTool(tools);
    if (!event.isError && screenshot && sameNamespace(event.toolName, screenshot.name)) {
      const tab = outputTab(event);
      if (tab !== undefined) this.target = { tool: screenshot.name, tab };
    }
    const images = event.content.filter(block => block.type === 'image');
    const capture = event.parentToolCallId ? this.pending.get(event.parentToolCallId) : undefined;
    for (const [index, image] of images.entries()) {
      try {
        const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
        const extension = extensions[image.mimeType ?? ''];
        if (!extension || !image.data || image.data.length > 45_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Unsupported or oversized diagnostic image');
        const bytes = Buffer.from(image.data, 'base64');
        if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) throw new Error('Empty or oversized diagnostic image');
        const stem = capture ? `checkpoint-${String(capture.revision).padStart(3, '0')}${index ? `-${index + 1}` : ''}` : `tool-${String(++this.imageSequence).padStart(3, '0')}`;
        mkdirSync(this.directory, { recursive: true });
        writeFileSync(join(this.directory, `${stem}.${extension}`), bytes, { flag: 'wx' });
        if (capture) capture.saved = true;
      } catch (error) { this.log('image_save_failed', error instanceof Error ? error.message : String(error)); }
    }
    if (isScreenshot(event.toolName)) {
      return { content: [{ type: 'text' as const, text: event.isError ? 'Diagnostic screenshot unavailable.' : 'Screenshot handled for human diagnostics.' }], details: {} };
    }
    const content = event.content.filter(block => block.type === 'text').map(block => ({ type: 'text' as const, text: cleanText(block.text ?? '', images) }));
    const duplicates = [event.details, event.structuredContent].some(value => {
      try { return JSON.stringify(withoutInlineImages(value)) !== JSON.stringify(value); }
      catch { return true; } // Drop opaque metadata rather than risk forwarding an image.
    });
    const changed = images.length > 0 || duplicates || content.some((block, index) => block.text !== event.content[index]?.text);
    return changed ? { content, details: {} } : undefined;
  }

  async capture(revision: number, parentId: string, ctx: CaptureContext, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const screenshot = findScreenshotTool(ctx.tools);
    if (!screenshot || this.target?.tool !== screenshot.name) {
      this.log('capture_skipped', 'No unique Browse screenshot tool with a known tab is available');
      return;
    }
    const pending = { revision, saved: false, tool: screenshot.name };
    this.pending.set(parentId, pending);
    try {
      const timeout = AbortSignal.timeout(10_000);
      const captureSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const outcome = await ctx.executeTool(screenshot.name, { tab: this.target.tab, format: 'png' }, { signal: captureSignal });
      if (outcome.isError || !pending.saved) this.log('capture_failed', 'Browse screenshot failed or returned no inline image');
    } catch (error) { this.log('capture_failed', error instanceof Error ? error.message : String(error)); }
    finally { this.pending.delete(parentId); }
  }
}
