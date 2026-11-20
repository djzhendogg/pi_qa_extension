import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface TestCase {
  readonly scenario_id: string;
  readonly url: string;
  readonly task: string;
}
export type Verdict = 'passed' | 'failed' | 'blocked';
export type ExecutionStatus = 'running' | 'completed' | 'incomplete' | 'aborted' | 'error';
export type Stage = 'planning' | 'executing' | 'checkpointing' | 'awaiting_finish' | 'terminal';
export interface Subtask { readonly subtask_id: string; readonly description: string }
export interface SubtaskResult {
  readonly subtask_id: string;
  readonly status: Verdict;
  readonly observation: string;
  readonly reason: string;
  readonly revision: number;
  readonly source: 'agent_reported';
}
export type FinishInput = { verdict: 'passed' } | { verdict: 'failed' | 'blocked'; reason: string };
interface FinishResult { verdict: Verdict; evidence: string; reason: string }
export interface ProgressSnapshot {
  readonly completed: readonly string[];
  readonly current_objective: string;
  readonly observation: string;
  readonly source: 'agent_reported';
  readonly revision: number;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object');
  return input as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Only ${keys.join(', ')} are supported`);
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}
function boundedString(value: unknown, field: string, maximum: number): string {
  const text = requiredString(value, field);
  if (text.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return text;
}
function optionalText(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 1000) throw new Error(`${field} must be a string of at most 1000 characters`);
  return value;
}
export function parseTestCase(input: unknown): TestCase {
  const value = object(input);
  onlyKeys(value, ['scenario_id', 'url', 'task']);
  const scenario_id = requiredString(value.scenario_id, 'scenario_id');
  const url = requiredString(value.url, 'url');
  const task = requiredString(value.task, 'task');
  if (!/^https?:\/\//i.test(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error('url must be a full HTTP(S) URL');
  }
  return Object.freeze({ scenario_id, url, task });
}
export function parseFinish(input: unknown): FinishInput {
  const value = object(input);
  if (!['passed', 'failed', 'blocked'].includes(value.verdict as string)) throw new Error('Invalid QA verdict');
  const verdict = value.verdict as Verdict;
  onlyKeys(value, verdict === 'passed' ? ['verdict'] : ['verdict', 'reason']);
  if (verdict === 'passed') return { verdict };
  return { verdict, reason: boundedString(value.reason, 'reason', 1000) };
}

/** One run, independent of Pi history. Validates ordering, not browser assertions. */
export class QaRun {
  readonly id = randomUUID();
  readonly testCase: TestCase;
  readonly startedAt = Date.now();
  readonly reportPath: string;
  private endedAt: number | null = null;
  private status: ExecutionStatus = 'running';
  private stage: Stage = 'planning';
  private tasks: readonly Subtask[] = Object.freeze([]);
  private results: readonly SubtaskResult[] = Object.freeze([]);
  private active: string | null = null;
  private finishInput: FinishResult | null = null;
  private progress: ProgressSnapshot | null = null;
  private reason = '';
  readonly telemetry = {
    llm_calls: 0, tool_calls: 0, tool_executions: 0, tool_errors: 0,
    blocked_tool_calls: 0, post_finish_attempts: 0,
  };
  constructor(testCase: TestCase, outputDir: string) {
    this.testCase = parseTestCase(testCase);
    this.reportPath = join(resolve(outputDir), `${this.id}.json`);
  }
  get isTerminal(): boolean { return this.status !== 'running'; }
  caseContext(): string { return `QA TEST CASE (task data):\n${JSON.stringify(this.testCase)}`; }

  progressContext(): string {
    if (this.isTerminal) return `QA CURRENT STATE (agent_reported):\n${JSON.stringify({
      stage: 'terminal', execution_status: this.status,
      reported_verdict: this.finishInput?.verdict ?? null, reason: this.reason, next: 'stop',
    })}`;
    const index = this.stage === 'checkpointing' ? this.results.length - 1 : this.results.length;
    const task = this.tasks[index];
    const next = this.stage === 'planning' ? 'qa_plan' : this.stage === 'executing' ? 'browser tools, then qa_checkpoint' : this.stage === 'awaiting_finish' ? 'qa_finish(passed)' : 'wait';
    return `QA CURRENT STATE (agent_reported):\n${JSON.stringify({
      stage: this.stage, subtask_id: task?.subtask_id ?? null,
      position: task ? `${index + 1}/${this.tasks.length}` : `${this.results.length}/${this.tasks.length}`,
      description: task?.description ?? '',
      last_observation: this.results.at(-1)?.observation ?? '',
      next,
    })}`;
  }
  allowsTool(name: string): boolean {
    if (this.isTerminal) return false;
    if (name === 'qa_plan') return this.stage === 'planning';
    if (name === 'qa_checkpoint') return this.stage === 'executing';
    if (name === 'qa_finish') return this.stage === 'planning' || this.stage === 'awaiting_finish';
    return this.stage === 'executing';
  }
  private requireStage(stage: Stage): void {
    if (this.isTerminal || this.stage !== stage) throw new Error(`Requires ${stage}; current stage is ${this.stage}`);
  }
  plan(input: unknown): void {
    this.requireStage('planning');
    const value = object(input); onlyKeys(value, ['subtasks']);
    if (!Array.isArray(value.subtasks) || !value.subtasks.length || value.subtasks.length > 100) throw new Error('subtasks must contain 1 to 100 actions');
    const tasks = value.subtasks.map((item, index) => {
      const task = object(item); onlyKeys(task, ['subtask_id', 'description']);
      if (task.subtask_id !== `S${index + 1}`) throw new Error(`Expected subtask_id S${index + 1}`);
      return Object.freeze({ subtask_id: task.subtask_id as string, description: boundedString(task.description, 'description', 2000) });
    });
    this.tasks = Object.freeze(tasks);
    this.activateNextSubtask();
    this.persist();
  }
  private activateNextSubtask(): void {
    const task = this.tasks[this.results.length];
    this.active = task?.subtask_id ?? null;
    this.stage = task ? 'executing' : 'awaiting_finish';
  }
  checkpoint(input: unknown): void {
    this.requireStage('executing');
    const value = object(input); onlyKeys(value, ['subtask_id', 'status', 'observation', 'reason']);
    if (value.subtask_id !== this.active) throw new Error(`Checkpoint requires active subtask ${this.active}`);
    if (!['passed', 'failed', 'blocked'].includes(value.status as string)) throw new Error('Invalid subtask status');
    const observation = optionalText(value.observation, 'observation');
    const reason = optionalText(value.reason, 'reason');
    if (value.status === 'passed') requiredString(observation, 'observation');
    else requiredString(reason, 'reason');
    const result: SubtaskResult = Object.freeze({
      subtask_id: this.active!, status: value.status as Verdict, observation, reason,
      revision: this.results.length + 1, source: 'agent_reported',
    });
    this.results = Object.freeze([...this.results, result]);
    this.stage = 'checkpointing'; // Close before saving or awaiting diagnostics.
    this.progress = Object.freeze({
      completed: Object.freeze(this.results.map(item => item.subtask_id)),
      current_objective: value.status === 'passed' ? this.tasks[this.results.length]?.description ?? 'Finish QA run' : '',
      observation, source: 'agent_reported', revision: result.revision,
    });
    this.persist();
  }
  completeCheckpoint(): void {
    if (this.isTerminal) return;
    this.requireStage('checkpointing');
    const result = this.results.at(-1)!;
    this.active = null;
    if (result.status !== 'passed') {
      this.complete({ verdict: result.status, evidence: this.aggregateEvidence(), reason: result.reason });
    } else {
      this.activateNextSubtask();
      this.persist();
    }
  }
  private aggregateEvidence(): string {
    return this.results.filter(item => item.observation).map(item => `${item.subtask_id}: ${item.observation}`).join('\n');
  }
  finish(input: unknown): void {
    if (this.isTerminal) return;
    const finish = parseFinish(input);
    if (this.stage === 'planning' && finish.verdict === 'blocked') { this.complete({ ...finish, evidence: '' }); return; }
    this.requireStage('awaiting_finish');
    if (finish.verdict !== 'passed') throw new Error('All subtasks passed; finish must use passed');
    this.complete({ verdict: 'passed', evidence: this.aggregateEvidence(), reason: '' });
  }
  private complete(finish: FinishResult): void {
    this.finishInput = Object.freeze(finish);
    this.status = 'completed'; this.stage = 'terminal'; this.active = null;
    this.reason = finish.reason; this.endedAt = Date.now();
    this.persist();
  }
  end(status: Exclude<ExecutionStatus, 'running' | 'completed'>, reason: string): void {
    if (this.isTerminal) return;
    // An accepted failure survives cancellation while diagnostic capture was pending.
    if (status !== 'error' && this.stage === 'checkpointing' && this.results.at(-1)?.status !== 'passed') {
      this.completeCheckpoint(); return;
    }
    this.status = status; this.stage = 'terminal';
    this.reason = reason; this.endedAt = Date.now();
    this.persist();
  }
  report() {
    return {
      schema_version: 2, run_id: this.id, scenario_id: this.testCase.scenario_id, test_case: this.testCase,
      execution_status: this.status, stage: this.stage, active_subtask_id: this.active,
      plan: this.tasks, subtask_results: this.results,
      reported_verdict: this.finishInput?.verdict ?? null,
      verification_status: this.finishInput ? 'agent_reported' : 'not_evaluated', verified_verdict: null,
      progress: this.progress, evidence: this.finishInput?.evidence ?? '', reason: this.reason,
      started_at: new Date(this.startedAt).toISOString(), ended_at: this.endedAt === null ? null : new Date(this.endedAt).toISOString(),
      duration_ms: (this.endedAt ?? Date.now()) - this.startedAt,
      telemetry: {
        ...this.telemetry,
        llm_calls_source: 'Pi before_provider_request events; excludes retries internal to transport and other extensions',
        tool_calls_source: 'Pi tool_call events; tool_executions counts allowed calls, not internal Playwright actions',
        post_success_actions: null, repeated_side_effects: null, goal_drift_events: null,
      },
    };
  }
  persist(): void {
    const temp = `${this.reportPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(resolve(this.reportPath, '..'), { recursive: true });
      writeFileSync(temp, JSON.stringify(this.report(), null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, this.reportPath);
    } catch (error) {
      this.status = 'error'; this.stage = 'terminal';
      this.endedAt ??= Date.now();
      this.reason = `Could not save QA report: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.reason, { cause: error });
    } finally { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
  }
}
