import { findScreenshotTool, outputTab, type CatalogTool, type Observation } from './qa-diagnostics.ts';
import type { ObservedUrls } from './qa-state.ts';

type Tab = string | number;
type TraceInput = Record<string, string | number | boolean>;
interface BrowseCall { toolCallId: string; toolName: string; input: Record<string, unknown> }
interface TraceEntry {
  tool: string;
  input: TraceInput;
  status: 'ok' | 'error' | 'pending';
  result: string | null;
}
export interface BrowseEvidence extends ObservedUrls {
  browse_trace: TraceEntry[];
}
interface StepCall {
  entry: TraceEntry;
  operation: string;
  namespace: string;
  inputTab?: Tab;
  tab?: Tab;
  readOnly: boolean;
  urlBefore?: string | null;
  urlAfter?: string | null;
}

const plainTools = new Set([
  'execute', 'status', 'tabs', 'navigate', 'snapshot', 'aria_snapshot', 'click', 'fill', 'type', 'press',
  'select', 'hover', 'drag', 'scroll', 'wait_for', 'dialog', 'upload', 'eval', 'screenshot', 'screenshot_diff',
  'network', 'console', 'recording', 'emulate', 'webmcp', 'handoff', 'demonstrate', 'settings',
  'close', 'close_tab', 'tab_close', 'session_new', 'session_list', 'session_use', 'session_reset',
  'session_delete', 'session_adopt',
]);
const safeKeys = ['action', 'tab', 'url', 'targetUrl', 'selector', 'ref', 'role', 'key', 'button', 'direction', 'force'];
const secretKey = /password|passcode|passwd|credential|secret|token|authorization|api[_-]?key|cookie|session[_-]?(?:id|key)|otp|^pass$/i;
const secretValue = /(["']?(?:password|passcode|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|authorization|api[_-]?key|cookie|set-cookie|session[_-]?(?:id|key)|otp)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}&]+)/gi;
const pageNeutralTools = /^(?:status|settings|network|console|recording|screenshot_diff|secrets(?:_.*)?)$/;
const sensitiveTools = /^(?:network|secrets(?:_|$)|upload|settings|webmcp|screenshot_diff)/;
const readOnlySnapshotScript = /^\s*(?:return\s+)?(?:await\s+)?(?:snapshot|ariaSnapshot)\(\s*\)\s*;?\s*$/;
const readOnlyUrlScript = /^\s*(?:return\s+)?(?:await\s+)?page\.url\(\s*\)\s*;?\s*$/;

function describeTool(name: string, tools: readonly CatalogTool[]) {
  const namespace = /^(?:mcp__(?:browse|browser(?:[-_]control)?)__|(?:browse|browser)_)/i.exec(name)?.[0];
  if (namespace !== undefined || plainTools.has(name)) {
    return { namespace: namespace ?? '', operation: name.slice(namespace?.length ?? 0) };
  }
  const screenshot = findScreenshotTool(tools);
  const customNamespace = screenshot?.name.slice(0, -'screenshot'.length);
  if (customNamespace && name.startsWith(customNamespace)) {
    return { namespace: customNamespace, operation: name.slice(customNamespace.length) };
  }
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) if (secretKey.test(key)) url.searchParams.delete(key);
  if (secretKey.test(url.hash)) url.hash = '';
  return url.href;
}

function excerpt(value: string, limit: number): string {
  const clean = value.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]')
    .replace(/https?:\/\/[^\s"'<>]+/g, url => cleanUrl(url) ?? '[URL omitted]')
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

function parsed(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function pageKey(namespace: string, tab: Tab): string {
  return JSON.stringify([namespace, tab]);
}

export class QaBrowseTrace {
  private calls: StepCall[] = [];
  private pending = new Map<string, StepCall>();
  private lastUrl = new Map<string, string>();

  begin(event: BrowseCall, tools: readonly CatalogTool[]): void {
    const tool = describeTool(event.toolName, tools);
    if (!tool) return;
    const entry: TraceEntry = {
      tool: event.toolName, input: traceInput(event.input, tool.operation), status: 'pending', result: null,
    };
    const { tab } = event.input;
    const inputTab = typeof tab === 'string' || typeof tab === 'number' ? tab : undefined;
    const readOnly = ['snapshot', 'aria_snapshot'].includes(tool.operation)
      || (tool.operation === 'execute' && (readOnlySnapshotScript.test(script(event.input)) || readOnlyUrlScript.test(script(event.input))));
    const call: StepCall = { entry, ...tool, inputTab, tab: inputTab, readOnly };
    this.calls.push(call);
    this.pending.set(event.toolCallId, call);
  }

  observe(event: Observation & BrowseCall): void {
    const call = this.pending.get(event.toolCallId);
    if (!call || call.entry.tool !== event.toolName) return;
    this.pending.delete(event.toolCallId);
    const text = event.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    const body = text.replace(/^(?:Tab:\s*|tab=)[^\r\n]*\r?\n/i, '').trim();
    const parsedBody = parsed(body);
    const payload = record(event.structuredContent) ?? record(parsedBody);
    const result = payload?.result ?? payload ?? parsedBody;
    const fields = record(result);
    call.entry.status = event.isError ? 'error' : 'ok';
    call.entry.result = resultExcerpt(body || (typeof result === 'string' ? result : ''), call, event.input);
    const tab = outputTab(event);
    call.tab = tab;
    if (event.isError || tab === undefined || sensitiveTools.test(call.operation)) return;
    const headerUrl = /^URL:\s*(\S+)\s*$/im.exec(text)?.[1];
    const plainUrl = typeof result === 'string' ? result : body;
    const resultUrl = /^(?:https?:\/\/[^\s]+|about:blank)$/i.test(plainUrl) ? plainUrl : null;
    call.urlBefore = cleanUrl(fields?.url_before ?? payload?.url_before);
    call.urlAfter = cleanUrl(fields?.url_after ?? payload?.url_after ?? fields?.url ?? payload?.url ?? headerUrl ?? resultUrl);
  }

  finish(): BrowseEvidence {
    let started = false;
    let changed = false;
    let firstPage: string | undefined;
    let url_before: string | null = null;
    let url_after: string | null = null;
    for (const call of this.calls) {
      if (pageNeutralTools.test(call.operation) || (call.operation === 'tabs' && !['new', 'close'].includes(String(call.entry.input.action)))) continue;
      const inputKey = call.inputTab === undefined ? undefined : pageKey(call.namespace, call.inputTab);
      const outputKey = call.tab === undefined ? undefined : pageKey(call.namespace, call.tab);
      const initialKey = inputKey ?? outputKey;
      if (!started) {
        firstPage = initialKey;
        url_before = call.urlBefore ?? (call.readOnly ? call.urlAfter : null) ?? (initialKey ? this.lastUrl.get(initialKey) : null) ?? null;
        started = true;
      } else if (!changed && initialKey && initialKey === firstPage) {
        url_before = call.urlBefore ?? (call.readOnly ? call.urlAfter : null) ?? url_before;
      }
      if (!call.readOnly) {
        changed = true;
        if (initialKey) this.lastUrl.delete(initialKey);
        else this.lastUrl.clear();
        if (outputKey) this.lastUrl.delete(outputKey);
      }
      if (outputKey && call.urlAfter) this.lastUrl.set(outputKey, call.urlAfter);
      url_after = (outputKey ? this.lastUrl.get(outputKey) : undefined) ?? null;
    }
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
    return { browse_trace, url_before, url_after };
  }
}
