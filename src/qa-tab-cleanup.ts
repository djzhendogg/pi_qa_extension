import { outputTab, sameNamespace, type CatalogTool, type CaptureContext, type Observation } from './qa-diagnostics.ts';

/** Browse TabsTool: action defaults to list; close takes an explicit tab. */
function tabsTool(tools: readonly CatalogTool[]) {
  const candidates = tools.filter(tool => {
    const schema = tool.parameters as { properties?: Record<string, unknown>; required?: unknown } | null;
    const action = schema?.properties?.action as { enum?: unknown } | undefined;
    const required = schema?.required ?? [];
    return /(?:^|[_:.-])tabs$/.test(tool.name) && schema?.properties?.tab &&
      Array.isArray(action?.enum) && action.enum.includes('close') &&
      Array.isArray(required) && required.every(key => key === 'action' || key === 'tab');
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Best-effort per-run cleanup. Never infer a tab from page content or enumerate other tabs. */
export class QaTabCleanup {
  private target: { tool: string; tab: string | number } | undefined;
  private closing: Promise<void> | undefined;
  private pending: { parent: string; tool: string; tab: string | number; admitted: boolean } | undefined;

  constructor(private readonly log: (event: string, reason: string) => void) {}

  observe(event: Observation, tools: readonly CatalogTool[]): void {
    if (event.isError || this.closing) return;
    const tool = tabsTool(tools);
    if (!tool || !sameNamespace(event.toolName, tool.name, 'tabs')) return;
    if (event.toolName === tool.name) {
      const action = event.input.action ?? 'list';
      if (action === 'close') {
        // A close response may name the next active tab, not the one it just closed.
        if (event.input.tab === this.target?.tab) this.target = undefined;
        return;
      }
      // Listing tabs does not choose a QA target, even if the result mentions one.
      if (action !== 'new') return;
    }
    const tab = outputTab(event);
    if (tab !== undefined) this.target = { tool: tool.name, tab };
  }

  /** Only the one nested close started by this object may cross the terminal gate. */
  allowsClose(event: { toolName: string; parentToolCallId?: string; input: Record<string, unknown> }): boolean {
    const pending = this.pending;
    if (!pending || pending.admitted || event.parentToolCallId !== pending.parent ||
        event.toolName !== pending.tool || event.input.action !== 'close' || event.input.tab !== pending.tab ||
        Object.keys(event.input).some(key => key !== 'action' && key !== 'tab')) return false;
    pending.admitted = true;
    return true;
  }

  close(parentId: string, ctx?: CaptureContext): Promise<void> {
    return this.closing ??= this.closeOnce(parentId, ctx);
  }

  private async closeOnce(parentId: string, ctx?: CaptureContext): Promise<void> {
    try {
      const tool = ctx && tabsTool(ctx.tools);
      if (!ctx || !tool || !this.target || this.target.tool !== tool.name) {
        this.log('tab_close_skipped', 'No unique Browse tabs tool with close action and a known QA tab is available');
        return;
      }
      this.pending = { parent: parentId, tool: tool.name, tab: this.target.tab, admitted: false };
      // Cleanup must still run after the user's model/tool signal was cancelled.
      const outcome = await ctx.executeTool(tool.name, { action: 'close', tab: this.target.tab }, { signal: AbortSignal.timeout(5000) });
      this.log(outcome.isError ? 'tab_close_failed' : 'tab_close_succeeded', outcome.isError ? 'Browse tabs(close) returned an error' : 'QA tab closed or released by Browse');
    } catch (error) {
      this.log('tab_close_failed', error instanceof Error ? error.message : String(error));
    } finally { this.pending = undefined; }
  }
}
