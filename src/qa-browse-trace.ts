import { findScreenshotTool, outputTab, type CatalogTool, type Observation } from './qa-diagnostics.ts';

type Tab = string | number;
type TraceInput = Record<string, string | number | boolean>;
interface BrowseCall { toolCallId: string; toolName: string; input: Record<string, unknown> }
interface TraceEntry {
  tool: string;
  input: TraceInput;
  status: 'ok' | 'error' | 'pending';
  result: string | null;
}
interface DomObservation { tab: Tab; url: string | null; text: string }
export interface BrowseEvidence {
  browse_trace: TraceEntry[];
  dom_before: DomObservation | null;
  dom_after: DomObservation | null;
}
interface StepCall {
  entry: TraceEntry;
  operation: string;
  namespace: string;
  inputTab?: Tab;
  tab?: Tab;
  readOnly: boolean;
  before?: DomObservation;
  after?: DomObservation;
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
const snapshotScript = /(?:^|[;\n])\s*(?:return\s+)?(?:await\s+)?(?:snapshot|ariaSnapshot)\(\s*\)\s*;?\s*$/;
const readOnlySnapshotScript = /^\s*(?:return\s+)?(?:await\s+)?(?:snapshot|ariaSnapshot)\(\s*\)\s*;?\s*$/;

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

function matchesUrl(dom: DomObservation | null, url: string | null): DomObservation | null {
  return dom?.url && url && dom.url !== url ? null : dom;
}

export class QaBrowseTrace {
  private calls: StepCall[] = [];
  private pending = new Map<string, StepCall>();
  private lastDom = new Map<string, DomObservation>();

  begin(event: BrowseCall, tools: readonly CatalogTool[]): void {
    const tool = describeTool(event.toolName, tools);
    if (!tool) return;
    const entry: TraceEntry = {
      tool: event.toolName, input: traceInput(event.input, tool.operation), status: 'pending', result: null,
    };
    const { tab } = event.input;
    const inputTab = typeof tab === 'string' || typeof tab === 'number' ? tab : undefined;
    const readOnly = ['snapshot', 'aria_snapshot'].includes(tool.operation)
      || (tool.operation === 'execute' && readOnlySnapshotScript.test(script(event.input)));
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
    const url = cleanUrl(fields?.url ?? payload?.url);
    const dom = (value: unknown, address: string | null = url): DomObservation | undefined => {
      const snippet = typeof value === 'string' ? excerpt(value, 2400) : '';
      return snippet ? { tab, url: address, text: snippet } : undefined;
    };
    call.after = dom(fields?.dom_after ?? fields?.snapshot);
    if (!call.after && (call.readOnly || (call.operation === 'execute' && snapshotScript.test(script(event.input))))) {
      call.after = dom(typeof result === 'string' ? result : fields?.text ?? (parsedBody === undefined ? body : undefined));
    }
    if (call.operation === 'execute') {
      call.before = dom(fields?.dom_before, cleanUrl(fields?.url_before) ?? (call.readOnly ? url : null));
    }
  }

  finish(urlBefore: string | null, urlAfter: string | null): BrowseEvidence {
    let started = false;
    let changed = false;
    let firstPage: string | undefined;
    let before: DomObservation | null = null;
    let after: DomObservation | null = null;
    const currentDom = new Map<string, DomObservation>();
    for (const call of this.calls) {
      if (pageNeutralTools.test(call.operation) || (call.operation === 'tabs' && !['new', 'close'].includes(String(call.entry.input.action)))) continue;
      const inputKey = call.inputTab === undefined ? undefined : pageKey(call.namespace, call.inputTab);
      const outputKey = call.tab === undefined ? undefined : pageKey(call.namespace, call.tab);
      const initialKey = inputKey ?? outputKey;
      if (!started) {
        firstPage = initialKey;
        before = call.before ?? (call.readOnly ? call.after : undefined) ?? (initialKey ? this.lastDom.get(initialKey) : undefined) ?? null;
        started = true;
      } else if (!changed && initialKey && initialKey === firstPage) {
        before = call.before ?? (call.readOnly ? call.after : undefined) ?? before;
      }
      if (!call.readOnly) {
        changed = true;
        if (initialKey) {
          this.lastDom.delete(initialKey);
          currentDom.delete(initialKey);
        } else {
          this.lastDom.clear();
          currentDom.clear();
        }
        if (outputKey) {
          this.lastDom.delete(outputKey);
          currentDom.delete(outputKey);
        }
      }
      if (outputKey && call.after) {
        this.lastDom.set(outputKey, call.after);
        currentDom.set(outputKey, call.after);
      }
      after = (outputKey ? currentDom.get(outputKey) : undefined) ?? null;
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
    return { browse_trace, dom_before: matchesUrl(before, cleanUrl(urlBefore)), dom_after: matchesUrl(after, cleanUrl(urlAfter)) };
  }
}
