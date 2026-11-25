import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolResultEventResult } from '@earendil-works/pi-coding-agent';

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
export interface DiagnosticImage { path: string; mimeType: string }
type CaptureTarget = { tool: string; tab: string | number };
type InternalCall = { toolName: string; parentToolCallId?: string; input: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const isScreenshot = (name: string) => /(?:^|[_:.-])screenshot$/.test(name);
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

function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function mcpText(value: unknown): string[] {
  const content = object(value)?.content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.flatMap(block => {
    const item = object(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
}

export function browseResultTexts(event: Observation): string[] {
  const structuredTexts = mcpText(event.structuredContent);
  const texts = structuredTexts.length ? structuredTexts : mcpText(event);
  // A proxy can serialize the entire MCP result as a text block.
  return texts.flatMap(text => {
    const wrapped = mcpText(parseJson(text));
    return wrapped.length ? wrapped : [text];
  });
}

export function outputTab(event: Observation): string | number | undefined {
  const structured = object(event.structuredContent);
  if (validTab(structured?.tab)) return structured.tab;
  for (const text of browseResultTexts(event)) {
    const parsed = object(parseJson(text));
    if (validTab(parsed?.tab)) return parsed.tab;
    const header = /^(?:Tab:\s*|tab=)([^\s,]+)/i.exec(text);
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

export function qaModelContext<T>(messages: readonly T[]): T[] {
  return stripModelImages(messages).map(message => {
    const result = object(message);
    if (result?.role !== 'toolResult' || result.toolName !== 'qa_plan' || !('nestedCalls' in result)) return message;
    const { nestedCalls: _nestedCalls, ...visible } = result;
    return visible as T;
  });
}

/** Keep image bytes local to diagnostics and the dedicated confidence request. */
export class QaDiagnostics {
  readonly directory: string;
  private readonly baselineId: string;
  private target: CaptureTarget | undefined;
  private baselineTab?: string | number;
  private baselineTabsTool?: string;
  private imageSequence = 0;
  private pending = new Map<string, CaptureTarget & { revision: number; image?: Promise<DiagnosticImage | undefined>; admitted: boolean }>();
  private baselineTabCall?: { parentId: string; tool: string; input: Record<string, unknown>; admitted: boolean; tab?: string | number };
  private captures = new Set<Promise<DiagnosticImage | undefined>>();
  private writes = new Set<Promise<DiagnosticImage | undefined>>();

  constructor(directory: string, runId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('Invalid diagnostics run id');
    this.directory = resolve(directory, runId);
    this.baselineId = `qa-baseline-${runId.toLowerCase()}`;
  }

  /** Pi supplies parentToolCallId for internal calls; model arguments cannot set it. */
  allowsCapture(event: InternalCall): boolean {
    const baseline = this.baselineTabCall;
    if (baseline && this.isBaselineTabCall(event) && !baseline.admitted &&
        Object.keys(event.input).length === Object.keys(baseline.input).length &&
        Object.entries(baseline.input).every(([key, value]) => event.input[key] === value)) {
      baseline.admitted = true;
      return true;
    }
    const capture = event.parentToolCallId === undefined ? undefined : this.pending.get(event.parentToolCallId);
    if (!capture || capture.admitted || capture.tool !== event.toolName || capture.tab !== event.input.tab) return false;
    capture.admitted = true;
    return true;
  }

  isBaselineTabCall(event: Pick<InternalCall, 'toolName' | 'parentToolCallId'>): boolean {
    const baseline = this.baselineTabCall;
    return !!baseline && baseline.tool === event.toolName && baseline.parentId === event.parentToolCallId;
  }

  targetsBaselineTab(event: InternalCall): boolean {
    if (!this.baselineTabsTool || !sameNamespace(event.toolName, this.baselineTabsTool, 'tabs')) return false;
    const { action, id, tab, tabs } = event.input;
    if (this.isBaselineTab(tab)) return true;
    if (event.toolName !== this.baselineTabsTool) return false;
    if (action === 'new') return typeof id === 'string' && id.trim() === this.baselineId;
    return action === 'close' && Array.isArray(tabs) && tabs.some(tab => this.isBaselineTab(tab));
  }

  observedBaselineTab(event: Observation): boolean {
    return this.baselineTabsTool !== undefined && sameNamespace(event.toolName, this.baselineTabsTool, 'tabs') &&
      this.isBaselineTab(outputTab(event));
  }

  private isBaselineTab(tab: unknown): boolean {
    return validTab(tab) && (tab === this.baselineId ||
      (this.baselineTab !== undefined && String(tab) === String(this.baselineTab)));
  }

  private filterBaselineTabListing(event: Observation) {
    const action = event.input.action ?? 'list';
    if (!this.baselineTabsTool || event.isError) return;
    const tabsList = event.toolName === this.baselineTabsTool && action === 'list';
    const status = event.toolName === this.baselineTabsTool.replace(/tabs$/, 'status');
    if (!tabsList && !status) return;
    const hideBaseline = (value: unknown) => {
      const payload = object(value);
      if (!Array.isArray(payload?.tabs)) return;
      const tabs = payload.tabs.filter(tab => !this.isBaselineTab(tab) && !this.isBaselineTab(object(tab)?.tab) && !this.isBaselineTab(object(tab)?.id));
      if (tabs.length !== payload.tabs.length) return { ...payload, tabs };
    };
    const filtered = hideBaseline(event.structuredContent);
    if (filtered) return {
      content: [{ type: 'text' as const, text: JSON.stringify(filtered) }], details: {},
      structuredContent: filtered as ToolResultEventResult['structuredContent'],
    };
    for (const block of event.content) {
      if (block.type !== 'text' || !block.text) continue;
      try {
        const filtered = hideBaseline(JSON.parse(block.text));
        if (filtered) return { content: [{ type: 'text' as const, text: JSON.stringify(filtered) }], details: {} };
      } catch { /* Ignore text that is not Browse's tab-list JSON. */ }
    }
  }

  log(event: string, reason: string): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(join(this.directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, reason: reason.slice(0, 1000) }) + '\n');
    } catch { /* Diagnostics failures must never fail the QA case. */ }
  }

  async flushWrites(): Promise<void> {
    await Promise.all(this.writes);
  }

  async flushCaptures(): Promise<void> {
    await Promise.all(this.captures);
  }

  private async saveImage(filename: string, mimeType: string, bytes: Buffer): Promise<DiagnosticImage | undefined> {
    const path = join(this.directory, filename);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(path, bytes, { flag: 'wx' });
      return { path, mimeType };
    } catch (error) {
      this.log('image_save_failed', error instanceof Error ? error.message : String(error));
    }
  }

  observe(event: Observation, tools: readonly CatalogTool[]) {
    if (this.isBaselineTabCall(event)) {
      const baseline = this.baselineTabCall!;
      if (baseline.admitted && baseline.input.action === 'new' && !event.isError) {
        baseline.tab = this.baselineTab = outputTab(event);
      }
      return;
    }
    const filteredTabList = this.filterBaselineTabListing(event);
    if (filteredTabList) return filteredTabList;
    const screenshot = findScreenshotTool(tools);
    const screenshotResult = isScreenshot(event.toolName);
    if (!screenshotResult && !event.isError && screenshot && sameNamespace(event.toolName, screenshot.name)) {
      const action = /(?:^|[_:.-])tabs$/.test(event.toolName) ? event.input.action ?? 'list' : undefined;
      if (action === 'close') {
        if (event.input.tab === this.target?.tab) this.target = undefined;
      } else if (action === undefined || action === 'new') {
        const tab = outputTab(event);
        if (tab !== undefined && !this.isBaselineTab(tab)) this.target = { tool: screenshot.name, tab };
      }
    }
    const images = event.content.filter(block => block.type === 'image');
    const capture = screenshotResult && event.parentToolCallId ? this.pending.get(event.parentToolCallId) : undefined;
    for (const [index, image] of images.entries()) {
      try {
        const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
        const extension = extensions[image.mimeType ?? ''];
        if (!extension || !image.data || image.data.length > 45_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Unsupported or oversized diagnostic image');
        const bytes = Buffer.from(image.data, 'base64');
        if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) throw new Error('Empty or oversized diagnostic image');
        const stem = capture
          ? `${capture.revision === 0 ? 'baseline' : `checkpoint-${String(capture.revision).padStart(3, '0')}`}${index ? `-${index + 1}` : ''}`
          : `tool-${String(++this.imageSequence).padStart(3, '0')}`;
        const write = this.saveImage(`${stem}.${extension}`, image.mimeType!, bytes);
        this.writes.add(write);
        void write.then(() => this.writes.delete(write));
        if (capture?.admitted && !event.isError) capture.image ??= write;
      } catch (error) { this.log('image_save_failed', error instanceof Error ? error.message : String(error)); }
    }
    if (screenshotResult) {
      return { content: [{ type: 'text' as const, text: event.isError ? 'Diagnostic screenshot unavailable.' : 'Screenshot handled for QA diagnostics.' }], details: {} };
    }
    const content = event.content.filter(block => block.type === 'text').map(block => ({ type: 'text' as const, text: cleanText(block.text ?? '', images) }));
    const duplicates = [event.details, event.structuredContent].some(value => {
      try { return JSON.stringify(withoutInlineImages(value)) !== JSON.stringify(value); }
      catch { return true; } // Drop opaque metadata rather than risk forwarding an image.
    });
    const changed = images.length > 0 || duplicates || content.some((block, index) => block.text !== event.content[index]?.text);
    return changed ? { content, details: {} } : undefined;
  }

  capture(revision: number, parentId: string, ctx: CaptureContext): Promise<DiagnosticImage | undefined> {
    return this.trackCapture(this.takeScreenshot(revision, parentId, ctx, this.target));
  }

  captureBaseline(parentId: string, ctx: CaptureContext): Promise<DiagnosticImage | undefined> {
    return this.trackCapture(this.target
      ? this.takeScreenshot(0, parentId, ctx, this.target)
      : this.takeBlankBaseline(parentId, ctx));
  }

  private trackCapture(capture: Promise<DiagnosticImage | undefined>): Promise<DiagnosticImage | undefined> {
    const job = capture.catch(error => {
      this.log('capture_failed', error instanceof Error ? error.message : String(error));
      return undefined;
    });
    this.captures.add(job);
    void job.then(() => this.captures.delete(job));
    return job;
  }

  private async takeBlankBaseline(parentId: string, ctx: CaptureContext): Promise<DiagnosticImage | undefined> {
    const screenshot = findScreenshotTool(ctx.tools);
    const tabs = screenshot && ctx.tools.find(tool => {
      const properties = object(object(tool.parameters)?.properties);
      const actions = object(properties?.action)?.enum;
      return tool.name === screenshot.name.replace(/screenshot$/, 'tabs') && properties?.id !== undefined &&
        Array.isArray(actions) && actions.includes('new') && actions.includes('close');
    });
    if (!screenshot || !tabs) {
      this.log('capture_skipped', 'Cannot capture the baseline without Browse screenshot and tabs tools');
      return;
    }
    this.baselineTabsTool = tabs.name;
    const opening = { parentId, tool: tabs.name, input: { action: 'new', id: this.baselineId }, admitted: false, tab: undefined as string | number | undefined };
    this.baselineTabCall = opening;
    try {
      const outcome = await ctx.executeTool(tabs.name, opening.input, { signal: AbortSignal.timeout(5000) });
      if (outcome.isError || opening.tab === undefined) {
        this.log('capture_failed', 'Browse could not open a temporary baseline tab');
        return;
      }
      return await this.takeScreenshot(0, parentId, ctx, { tool: screenshot.name, tab: opening.tab });
    } finally {
      try {
        // Browse can create the tab even if the opening response is lost.
        const input = { action: 'close', tab: opening.tab ?? this.baselineId };
        this.baselineTabCall = { parentId, tool: tabs.name, input, admitted: false };
        const outcome = await ctx.executeTool(tabs.name, input, { signal: AbortSignal.timeout(5000) });
        if (outcome.isError) this.log('baseline_tab_close_failed', 'Browse could not close the temporary baseline tab');
      } catch (error) {
        this.log('baseline_tab_close_failed', String(error));
      } finally { this.baselineTabCall = undefined; }
    }
  }

  private async takeScreenshot(revision: number, parentId: string, ctx: CaptureContext, target: CaptureTarget | undefined): Promise<DiagnosticImage | undefined> {
    if (this.pending.has(parentId)) {
      this.log('capture_skipped', 'Another screenshot is pending for this tool call ID');
      return;
    }
    const screenshot = findScreenshotTool(ctx.tools);
    if (!screenshot || target?.tool !== screenshot.name) {
      this.log('capture_skipped', 'No unique Browse screenshot tool with a known tab is available');
      return;
    }
    const pending: CaptureTarget & { revision: number; image?: Promise<DiagnosticImage | undefined>; admitted: boolean } = { ...target, revision, admitted: false };
    this.pending.set(parentId, pending);
    try {
      // Pi aborts the agent loop after a terminal verdict. Diagnostic jobs have their own deadline.
      const outcome = await ctx.executeTool(screenshot.name, { tab: pending.tab, format: 'png' }, { signal: AbortSignal.timeout(10_000) });
      if (!outcome.isError && pending.image) return pending.image;
      this.log('capture_failed', 'Browse screenshot failed or returned no usable inline image');
    } finally { this.pending.delete(parentId); }
  }
}
