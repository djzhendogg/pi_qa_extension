import { browseResultTexts, findScreenshotTool, type CatalogTool, type Observation } from './qa-diagnostics.ts';
import { sanitizeObservedUrl } from './qa-state.ts';

type TraceInput = Record<string, string | number | boolean>;
interface BrowseCall { toolCallId: string; toolName: string; input: Record<string, unknown> }
interface TraceEntry {
  tool: string;
  input: TraceInput;
  status: 'ok' | 'error' | 'pending';
  result: string | null;
}
export interface BrowseEvidence {
  browse_trace: TraceEntry[];
}
interface StepCall {
  entry: TraceEntry;
  operation: string;
}

const plainTools = new Set([
  'execute', 'status', 'tabs', 'navigate', 'snapshot', 'aria_snapshot', 'click', 'fill', 'type', 'press',
  'select', 'hover', 'drag', 'scroll', 'wait_for', 'dialog', 'upload', 'eval', 'screenshot', 'screenshot_diff',
  'network', 'console', 'recording', 'emulate', 'webmcp', 'handoff', 'demonstrate', 'settings',
  'close', 'close_tab', 'tab_close', 'session_new', 'session_list', 'session_use', 'session_reset',
  'session_delete', 'session_adopt',
]);
const safeKeys = ['action', 'tab', 'url', 'targetUrl', 'selector', 'ref', 'role', 'key', 'button', 'direction', 'force'];
const secretValue = /(["']?(?:password|passcode|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|authorization|api[_-]?key|cookie|set-cookie|session[_-]?(?:id|key)|otp)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}&]+)/gi;
const sensitiveTools = /^(?:network|secrets(?:_|$)|upload|settings|webmcp|screenshot_diff)/;

function browseOperation(name: string, tools: readonly CatalogTool[]): string | undefined {
  const namespace = /^(?:mcp__(?:browse|browser(?:[-_]control)?)__|(?:browse|browser)_)/i.exec(name)?.[0];
  if (namespace !== undefined || plainTools.has(name)) {
    return name.slice(namespace?.length ?? 0);
  }
  const screenshot = findScreenshotTool(tools);
  const customNamespace = screenshot?.name.slice(0, -'screenshot'.length);
  if (customNamespace && name.startsWith(customNamespace)) {
    return name.slice(customNamespace.length);
  }
}

function excerpt(value: string, limit: number): string {
  const clean = value.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]')
    .replace(/https?:\/\/[^\s"'<>]+/g, url => sanitizeObservedUrl(url) ?? '[URL omitted]')
    .replace(secretValue, '$1[redacted]')
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .trim();
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…';
}

function script(input: BrowseCall['input']): string {
  return typeof input.code === 'string' ? input.code : typeof input.script === 'string' ? input.script : '';
}

function traceInput(input: BrowseCall['input'], operation: string): TraceInput {
  const selected: TraceInput = {};
  const keys = operation === 'select' ? [...safeKeys, 'value', 'label', 'option'] : safeKeys;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' || typeof value === 'boolean') selected[key] = value;
    if (typeof value === 'string') selected[key] = excerpt(value, 180);
  }
  if (operation === 'execute') {
    const actions = [...script(input).matchAll(/\b(goto|navigate|click|fill|type|press|select|selectOption|hover|scroll|waitFor|snapshot|ariaSnapshot)\s*\(/g)]
      .map(match => match[1]).join(' → ');
    if (actions) selected.actions = excerpt(actions, 200);
  }
  return selected;
}

function resultExcerpt(text: string, call: StepCall, input: BrowseCall['input']): string | null {
  if (sensitiveTools.test(call.operation)) return null;
  if (call.operation === 'fill' || call.operation === 'type') {
    for (const value of [input.value, input.text]) {
      if (typeof value === 'string' && value) {
        text = text.replaceAll(value, '[redacted]').replaceAll(JSON.stringify(value).slice(1, -1), '[redacted]');
      }
    }
  }
  return excerpt(text, 600) || null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class QaBrowseTrace {
  private calls: StepCall[] = [];
  private pending = new Map<string, StepCall>();

  begin(event: BrowseCall, tools: readonly CatalogTool[]): void {
    const operation = browseOperation(event.toolName, tools);
    if (!operation) return;
    const entry: TraceEntry = {
      tool: event.toolName, input: traceInput(event.input, operation), status: 'pending', result: null,
    };
    const call: StepCall = { entry, operation };
    this.calls.push(call);
    this.pending.set(event.toolCallId, call);
  }

  observe(event: Observation & BrowseCall): void {
    const call = this.pending.get(event.toolCallId);
    if (!call || call.entry.tool !== event.toolName) return;
    this.pending.delete(event.toolCallId);
    const text = browseResultTexts(event).join('\n');
    const body = text.replace(/^(?:Tab:\s*|tab=)[^\r\n]*\r?\n/i, '').trim();
    const result = record(event.structuredContent)?.result;
    call.entry.status = event.isError ? 'error' : 'ok';
    call.entry.result = resultExcerpt(body || (typeof result === 'string' ? result : ''), call, event.input);
  }

  finish(): BrowseEvidence {
    // Preserve the call sequence and favor the most recent text when the trace is large.
    let remaining = 12_000;
    for (const { entry } of this.calls.toReversed()) {
      if (!entry.result) continue;
      entry.result = remaining > 0 ? entry.result.slice(0, remaining) : null;
      remaining -= entry.result?.length ?? 0;
    }
    const browse_trace = this.calls.map(call => call.entry);
    this.calls = [];
    this.pending.clear();
    return { browse_trace };
  }
}
