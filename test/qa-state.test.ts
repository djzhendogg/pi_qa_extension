import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseTestCase, parseFinish, QaRun } from '../src/qa-state.ts';

const fixture = { scenario_id: '../TC-001', url: 'https://example.com', task: 'Create item' };
const subtasks = [{ subtask_id: 'S1', description: 'Fill and submit form' }, { subtask_id: 'S2', description: 'Check list' }];
function workspace(t: TestContext) {
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  t.after(() => { assert.equal(dirname(dir), process.cwd()); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function planned(t: TestContext) {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  run.plan({ subtasks });
  return run;
}
const result = (subtask_id = 'S1', status = 'passed', observation = 'Selected value visible', reason = '') => ({
  subtask_id, status, observation, reason,
  url_before: null,
  url_after: observation ? fixture.url : null,
});
const finish = { verdict: 'passed' };

test('new input has scenario_id and no expected; preserves original task and rejects old schema', () => {
  for (const input of [null, {}, { id: 'old', url: fixture.url, task: 't', expected: 'x' }, { ...fixture, url: 'http' }, { ...fixture, url: 'https:example.com' }, { ...fixture, url: 'http:/example.com' }, { ...fixture, url: 'file:///x' }, { ...fixture, scenario_id: ' ' }, { ...fixture, expected: 'hidden criterion' }]) assert.throws(() => parseTestCase(input));
  const input = { ...fixture, task: '  Original\n"quoted" text  ' };
  const parsed = parseTestCase(input);
  input.task = 'changed';
  assert.equal(parsed.task, '  Original\n"quoted" text  ');
  assert.ok(Object.isFrozen(parsed));
  assert.equal('expected' in parsed, false);
});

test('plan is validated atomically, immutable, bounded and accepted once', t => {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  for (const input of [{ subtasks: [] }, { subtasks: [{ subtask_id: 'S2', description: 'x' }] }, { subtasks: [{ subtask_id: 'S1', description: ' ' }] }, { subtasks: [{ ...subtasks[0], expected_result: 'x' }] }, { subtasks: Array(101).fill(subtasks[0]) }, { subtasks: [{ subtask_id: 'S1', description: 'x'.repeat(2001) }] }]) assert.throws(() => run.plan(input));
  assert.equal(run.report().stage, 'planning');
  const input = structuredClone(subtasks);
  run.plan({ subtasks: input });
  input[0].description = 'changed';
  assert.equal(run.report().plan[0].description, subtasks[0].description);
  assert.throws(() => run.plan({ subtasks }));
  assert.equal(run.report().stage, 'executing');
});

test('plan activates S1 and checkpoints enforce ordered work without a separate activation', t => {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  assert.equal(run.allowsTool('browser_execute'), false);
  assert.throws(() => run.checkpoint(result()));
  run.plan({ subtasks });
  assert.equal(run.report().active_subtask_id, 'S1');
  assert.equal(run.report().stage, 'executing');
  assert.equal(run.allowsTool('browser_execute'), true);
  assert.throws(() => run.checkpoint(result('S2')));
  assert.throws(() => run.finish(finish));
});

test('checkpoint persists before diagnostics; no next action until completion; final evidence is aggregated', t => {
  const run = planned(t);
  run.checkpoint(result());
  assert.equal(run.report().stage, 'checkpointing');
  assert.equal(run.allowsTool('browser_execute'), false);
  assert.throws(() => run.checkpoint(result()));
  const saved = JSON.parse(readFileSync(run.reportPath, 'utf8'));
  assert.equal(saved.subtask_results[0].revision, 1);
  assert.equal(saved.execution_status, 'running');
  run.completeCheckpoint();
  assert.equal(run.report().stage, 'executing');
  assert.equal(run.report().active_subtask_id, 'S2');
  assert.throws(() => run.checkpoint(result('S1')));
  run.checkpoint(result('S2', 'passed', 'List checked'));
  run.completeCheckpoint();
  assert.equal(run.report().stage, 'awaiting_finish');
  assert.equal(run.allowsTool('browser_execute'), false);
  assert.throws(() => run.finish({ verdict: 'failed', reason: 'invented' }));
  run.finish(finish);
  run.finish({ verdict: 'failed', reason: 'late' });
  const report = run.report();
  assert.equal(report.reported_verdict, 'passed');
  assert.equal(report.evidence, 'S1: Selected value visible\nS2: List checked');
  assert.equal(report.schema_version, 2);
  assert.equal(report.scenario_id, fixture.scenario_id);
  assert.equal(report.verification_status, 'agent_reported');
  assert.equal(report.verified_verdict, null);
  assert.equal(readdirSync(dirname(run.reportPath)).length, 1);
});

for (const status of ['failed', 'blocked'] as const) test(`${status} checkpoint finishes after diagnostics, including abort in between`, t => {
  const run = planned(t);
  run.checkpoint(result('S1', status, '', 'Browser unavailable after reconnect attempt'));
  assert.equal(run.isTerminal, false);
  run.end('aborted', 'User abort during screenshot');
  assert.equal(run.report().reported_verdict, status);
  assert.equal(run.report().execution_status, 'completed');
  assert.equal(run.report().subtask_results.length, 1);
  assert.equal(run.report().plan.length, 2);
  assert.equal(run.report().active_subtask_id, null);
  assert.equal(run.allowsTool('browser_execute'), false);
});

test('invalid checkpoint does not mutate active task or revision', t => {
  const run = planned(t);
  for (const input of [result('S2'), result('S1', 'passed', ' '), result('S1', 'blocked', '', ''), result('S1', 'failed', '', ''), result('S1', 'unknown'), result('S1', 'passed', 'x'.repeat(1001))]) assert.throws(() => run.checkpoint(input));
  assert.equal(run.report().stage, 'executing');
  assert.equal(run.report().subtask_results.length, 0);
  run.checkpoint(result());
  run.completeCheckpoint();
  assert.throws(() => run.checkpoint(result()));
  assert.equal(run.report().progress?.revision, 1);
});

test('checkpoint URLs are required and invalid values leave the step retryable', t => {
  const run = planned(t);
  for (const [field, values] of Object.entries({
    url_before: [undefined, '', '/form'],
    url_after: [undefined, 42, 'invalid url'],
  })) {
    for (const value of values) {
      assert.throws(() => run.checkpoint({ ...result(), [field]: value }), new RegExp(field));
    }
  }
  assert.equal(run.report().subtask_results.length, 0);
  run.checkpoint({ ...result(), url_before: 'about:blank', url_after: null });
  run.completeCheckpoint();
  run.checkpoint(result('S2'));
  assert.deepEqual(run.report().subtask_results.map(item => item.confidence_score), [null, null]);
});

test('only blocked emergency finish is available before plan', t => {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  assert.throws(() => run.finish(finish));
  assert.throws(() => run.finish({ verdict: 'blocked', reason: ' ' }));
  run.finish({ verdict: 'blocked', reason: 'Required credentials missing; no safe recovery available' });
  assert.equal(run.report().reported_verdict, 'blocked');
  assert.throws(() => run.plan({ subtasks }));
});

test('compact context restores current task without repeating complete plan or past descriptions', t => {
  const run = planned(t);
  assert.match(run.progressContext()!, /browser tools, then qa_checkpoint/);
  run.checkpoint(result()); run.completeCheckpoint();
  assert.match(run.progressContext()!, /Check list/);
  assert.doesNotMatch(run.progressContext()!, /Fill and submit form/);
  assert.match(run.progressContext()!, /Selected value visible/);
  assert.match(run.caseContext(), /Create item/);
});

test('unique report names and technical settlement without a verdict', t => {
  const dir = workspace(t);
  const one = new QaRun(parseTestCase(fixture), dir), two = new QaRun(parseTestCase(fixture), dir);
  one.end('incomplete', 'Agent stopped'); two.end('aborted', 'User stopped');
  assert.notEqual(one.reportPath, two.reportPath);
  assert.equal(one.report().reported_verdict, null);
  assert.equal(readdirSync(dir).length, 2);
});

test('storage failure closes gate and retains accepted checkpoint', t => {
  const dir = workspace(t);
  const run = new QaRun(parseTestCase(fixture), dir);
  run.plan({ subtasks });
  rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, 'occupied');
  assert.throws(() => run.checkpoint(result()));
  assert.equal(run.report().execution_status, 'error');
  assert.equal(run.report().subtask_results.length, 1);
  assert.equal(run.allowsTool('browser_execute'), false);
  run.end('aborted', 'late');
  assert.equal(run.report().execution_status, 'error');
});

test('terminal state names accepted outcome and never presents pending task as current', t => {
  const run = planned(t);
  run.checkpoint(result('S1', 'blocked', '', 'Required login unavailable after recovery'));
  run.completeCheckpoint();
  const context = run.progressContext();
  assert.doesNotMatch(context, /Check list/);
  assert.match(context, /blocked/);
  assert.match(context, /Required login unavailable after recovery/);
});

test('finish input requires only verdict for passed and only reason for non-passed', () => {
  assert.deepEqual(parseFinish({ verdict: 'passed' }), { verdict: 'passed' });
  assert.deepEqual(parseFinish({ verdict: 'blocked', reason: 'Credentials missing' }), { verdict: 'blocked', reason: 'Credentials missing' });
  for (const input of [
    { verdict: 'passed', reason: '' }, { verdict: 'passed', evidence: 'Extra work' },
    { verdict: 'blocked' }, { verdict: 'blocked', reason: ' ' },
    { verdict: 'blocked', reason: 'Obstacle', evidence: 'Extra work' },
  ]) assert.throws(() => parseFinish(input));
});

test('failure saving the next-task transition closes browser gate after accepted checkpoint', t => {
  const run = planned(t); run.checkpoint(result());
  const output = dirname(run.reportPath);
  rmSync(output, { recursive: true, force: true }); writeFileSync(output, 'occupied');
  assert.throws(() => run.completeCheckpoint());
  assert.equal(run.report().execution_status, 'error');
  assert.equal(run.report().subtask_results.length, 1);
  assert.equal(run.report().subtask_results[0].subtask_id, 'S1');
  assert.equal(run.allowsTool('browser_execute'), false);
});
