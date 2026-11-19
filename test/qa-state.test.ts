import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseTestCase, QaRun } from '../src/qa-state.ts';

const fixture = { id: '../TC-001', url: 'https://example.com', task: 'Create item', expected: 'Item exists' };
function workspace(t: TestContext) {
  // Sandbox permits atomic renames inside the workspace, unlike its redirected TEMP.
  const dir = mkdtempSync(join(process.cwd(), '.qa-test-'));
  t.after(() => {
    assert.equal(dirname(dir), process.cwd());
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('rejects missing expected and unsafe URL schemes without changing task text', () => {
  for (const input of [null, {}, { ...fixture, expected: ' ' }, { ...fixture, url: 'file:///secret' }]) {
    assert.throws(() => parseTestCase(input));
  }
  const input = { ...fixture, task: '  Original task\nwith details  ' };
  const parsed = parseTestCase(input);
  input.task = 'Changed';
  assert.equal(parsed.task, '  Original task\nwith details  ');
  assert.ok(Object.isFrozen(parsed));
});

test('finish stores only an agent-reported verdict and is idempotent', t => {
  const dir = workspace(t);
  const run = new QaRun(parseTestCase(fixture), dir);
  run.finish({ verdict: 'passed', evidence: 'Toast visible', reason: '' });
  run.finish({ verdict: 'failed', evidence: '', reason: 'late result' });
  const result = JSON.parse(readFileSync(run.reportPath, 'utf8'));
  assert.equal(result.execution_status, 'completed');
  assert.equal(result.reported_verdict, 'passed');
  assert.equal(result.verification_status, 'agent_reported');
  assert.equal(result.verified_verdict, null);
  assert.equal(result.telemetry.post_success_actions, null);
  assert.equal(result.test_case.task, 'Create item');
  assert.equal(readdirSync(dir).length, 1);
});

test('invalid finish leaves run active; invalid verdict and whitespace evidence are rejected', t => {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  for (const input of [
    { verdict: 'passed', evidence: ' ', reason: '' },
    { verdict: 'failed', evidence: '', reason: '' },
    { verdict: 'blocked', evidence: '', reason: '' },
    { verdict: 'unknown', evidence: 'claim', reason: '' },
  ]) assert.throws(() => run.finish(input));
  assert.equal(run.isTerminal, false);
});

test('unique report names cannot escape output directory through case id', t => {
  const dir = workspace(t);
  const first = new QaRun(parseTestCase(fixture), dir);
  const second = new QaRun(parseTestCase(fixture), dir);
  first.end('incomplete', 'No qa_finish');
  second.end('aborted', 'User interrupted');
  assert.notEqual(first.reportPath, second.reportPath);
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(JSON.parse(readFileSync(first.reportPath, 'utf8')).reported_verdict, null);
});

test('persistence failure keeps terminal gate closed and records error in memory', t => {
  const dir = workspace(t);
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, 'occupied');
  const run = new QaRun(parseTestCase(fixture), file);
  assert.throws(() => run.finish({ verdict: 'passed', evidence: 'toast', reason: '' }));
  assert.equal(run.isTerminal, true);
  assert.equal(run.report().execution_status, 'error');
  assert.match(run.report().reason, /report/i);
});

test('anchor retains original goal and labels success as unverified', t => {
  const run = new QaRun(parseTestCase(fixture), workspace(t));
  assert.match(run.anchor(), /Create item/);
  assert.match(run.anchor(), /Item exists/);
  assert.match(run.anchor(), /qa_finish/);
  assert.match(run.anchor(), /unverified/i);
});
