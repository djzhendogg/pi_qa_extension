import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface TestCase {
  readonly id: string;
  readonly url: string;
  readonly task: string;
  readonly expected: string;
}
export type Verdict = 'passed' | 'failed' | 'blocked';
export type ExecutionStatus = 'running' | 'completed' | 'incomplete' | 'aborted' | 'error';
export interface FinishInput { verdict: Verdict; evidence: string; reason: string }
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
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}
function boundedString(value: unknown, field: string, maximum: number): string {
  const text = requiredString(value, field);
  if (text.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return text;
}
export function parseTestCase(input: unknown): TestCase {
  const value = object(input);
  const id = requiredString(value.id, 'id');
  const url = requiredString(value.url, 'url');
  const task = requiredString(value.task, 'task');
  const expected = requiredString(value.expected, 'expected');
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('url must use HTTP(S)');
  return Object.freeze({ id, url, task, expected });
}
export function parseFinish(input: unknown): FinishInput {
  const value = object(input);
  if (!['passed', 'failed', 'blocked'].includes(value.verdict as string)) throw new Error('Invalid QA verdict');
  const verdict = value.verdict as Verdict;
  if (typeof value.evidence !== 'string' || typeof value.reason !== 'string') {
    throw new Error('evidence and reason must be strings');
  }
  if (verdict === 'passed') requiredString(value.evidence, 'evidence');
  else requiredString(value.reason, 'reason');
  return { verdict, evidence: value.evidence, reason: value.reason };
}

/** One run, independent of Pi's model history. No browser-state inference. */
export class QaRun {
  readonly id = randomUUID();
  readonly testCase: TestCase;
  readonly startedAt = Date.now();
  readonly reportPath: string;
  private endedAt: number | null = null;
  private status: ExecutionStatus = 'running';
  private finishInput: FinishInput | null = null;
  private progress: ProgressSnapshot | null = null;
  private reason = '';
  readonly telemetry = {
    llm_calls: 0,
    tool_calls: 0,
    tool_executions: 0,
    tool_errors: 0,
    blocked_tool_calls: 0,
    post_finish_attempts: 0,
  };

  constructor(testCase: TestCase, outputDir: string) {
    this.testCase = parseTestCase(testCase);
    this.reportPath = join(resolve(outputDir), `${this.id}.json`);
  }
  get isTerminal(): boolean { return this.status !== 'running'; }

  caseContext(): string {
    return `QA TEST CASE (task data):\n${JSON.stringify(this.testCase, null, 2)}`;
  }

  progressContext(): string | undefined {
    return this.progress ? `QA PROGRESS (agent_reported):\n${JSON.stringify(this.progress)}` : undefined;
  }

  checkpoint(input: unknown): void {
    if (this.isTerminal) throw new Error('QA run is terminal; checkpoint rejected');
    const value = object(input);
    if (!Array.isArray(value.completed) || value.completed.length > 20) {
      throw new Error('completed must be an array of at most 20 short summaries');
    }
    const completed = value.completed.map((item, index) => boundedString(item, `completed[${index}]`, 300));
    const currentObjective = boundedString(value.current_objective, 'current_objective', 500);
    const observation = value.observation ?? '';
    if (typeof observation !== 'string' || observation.length > 1000) {
      throw new Error('observation must be a string of at most 1000 characters');
    }
    // Replace the snapshot rather than appending stale objectives forever.
    this.progress = Object.freeze({
      completed: Object.freeze(completed),
      current_objective: currentObjective,
      observation,
      source: 'agent_reported' as const,
      revision: (this.progress?.revision ?? 0) + 1,
    });
    this.persist();
  }

  finish(input: unknown): void {
    if (this.isTerminal) return;
    const finish = parseFinish(input); // Invalid input must not close the gate.
    this.finishInput = finish;
    this.status = 'completed'; // Close synchronously, before any filesystem operation.
    this.reason = finish.reason;
    this.endedAt = Date.now();
    this.persist();
  }

  end(status: Exclude<ExecutionStatus, 'running' | 'completed'>, reason: string): void {
    if (this.isTerminal) return;
    this.status = status;
    this.reason = reason;
    this.endedAt = Date.now();
    this.persist();
  }

  report() {
    return {
      schema_version: 1,
      run_id: this.id,
      case_id: this.testCase.id,
      test_case: this.testCase,
      execution_status: this.status,
      reported_verdict: this.finishInput?.verdict ?? null,
      verification_status: this.finishInput ? 'agent_reported' : 'not_evaluated',
      verified_verdict: null,
      progress: this.progress,
      evidence: this.finishInput?.evidence ?? '',
      reason: this.reason,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: this.endedAt === null ? null : new Date(this.endedAt).toISOString(),
      duration_ms: (this.endedAt ?? Date.now()) - this.startedAt,
      telemetry: {
        ...this.telemetry,
        llm_calls_source: 'Pi before_provider_request events; excludes retries internal to transport and other extensions',
        tool_calls_source: 'Pi tool_call events; tool_executions counts allowed calls, not internal Playwright actions',
        post_success_actions: null,
        repeated_side_effects: null,
        goal_drift_events: null,
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
      this.status = 'error';
      this.endedAt ??= Date.now();
      this.reason = `Could not save QA report: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.reason, { cause: error });
    } finally {
      // A failed write/rename must not hide its original error during cleanup.
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}
