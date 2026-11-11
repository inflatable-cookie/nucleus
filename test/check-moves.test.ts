import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMoves, checkShardMoves } from '../scripts/check-moves';

const OLD = `import { digest } from './store';
const LIMIT = 2;
export function reason(task: { id: string }): string {
  return digest(\`Waiting: \${task.id}\`) + LIMIT;
}
export class Old {
  async stop(id: string) { return this.store.update(id, 'stopped'); }
}
`;

function repo(t: TestContext, before: Record<string, string>, after: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'check-moves-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'server'));
  mkdirSync(join(dir, 'host'));
  mkdirSync(join(dir, 'test', 'support'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' });
  git('init', '-q');
  const commit = (files: Record<string, string>, tag: string) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', tag);
    git('tag', tag);
  };
  commit(before, 'before');
  commit(after, 'after');
  return dir;
}

const moved = (body = "return digest(`Waiting: ${task.id}`) + LIMIT;", head = 'export function reason', imports = "import { digest } from './store';") =>
  `${imports}\nimport { LIMIT } from './limits';\n// Comments and layout may change.\n${head}(task: { id: string }): string {\n    ${body}\n}\n`;

test('an unchanged move passes, and a changed body is caught', t => {
  const unchanged = repo(t, { 'server/old.ts': OLD }, { 'server/old.ts': OLD.replace(/export function reason[^]*?\n}\n/, ''), 'server/new.ts': moved() });
  const same = checkMoves({ repo: unchanged, before: 'before', after: 'after', moves: ['reason'], from: 'server/old.ts' });
  assert.deepEqual(same.results, [{ move: 'reason', ok: true, detail: 'server/old.ts -> server/new.ts' }]);

  const reworded = repo(t, { 'server/old.ts': OLD }, { 'server/new.ts': moved("return digest(`Waiting on: ${task.id}`) + LIMIT;") });
  const [result] = checkMoves({ repo: reworded, before: 'before', after: 'after', moves: ['reason'], from: 'server/old.ts' }).results;
  assert.equal(result!.ok, false);
  assert.match(result!.detail, /body differs at token .*Waiting on/);
});

test('losing or gaining async is a difference, because synchronous stays synchronous', t => {
  const dir = repo(t, { 'server/old.ts': OLD }, { 'server/new.ts': moved(undefined, 'export async function reason') });
  const [result] = checkMoves({ repo: dir, before: 'before', after: 'after', moves: ['reason'], from: 'server/old.ts' }).results;
  assert.equal(result!.ok, false);
});

test('a receiver rewrite is forgiven only when named', t => {
  const owner = "export class Stops {\n  async stop(id: string) { return this.resolution.store.update(id, 'stopped'); }\n}\n";
  const dir = repo(t, { 'server/old.ts': OLD }, { 'server/stops.ts': owner });
  const moves = ['Old.stop=Stops.stop'];
  assert.equal(checkMoves({ repo: dir, before: 'before', after: 'after', moves }).results[0]!.ok, false);
  assert.equal(checkMoves({ repo: dir, before: 'before', after: 'after', moves, rewrites: ['this.resolution=this'] }).results[0]!.ok, true);
});

test('a name that now resolves to another module is a difference', t => {
  const dir = repo(t, { 'server/old.ts': OLD }, { 'server/new.ts': moved(undefined, undefined, "import { digest } from './other';") });
  const [result] = checkMoves({ repo: dir, before: 'before', after: 'after', moves: ['reason'], from: 'server/old.ts' }).results;
  assert.equal(result!.ok, false);
  assert.match(result!.detail, /`digest` came from server\/store, now from server\/other/);
});

test('a name that never moved is reported', t => {
  const dir = repo(t, { 'server/old.ts': OLD }, { 'server/old.ts': OLD });
  const [result] = checkMoves({ repo: dir, before: 'before', after: 'after', moves: ['reason'], from: 'server/old.ts' }).results;
  assert.match(result!.detail, /did not move/);
});

test('a move into the host package remains visible to the checker', t => {
  const dir = repo(t, { 'server/old.ts': 'export function answer() { return 42; }' },
    { 'server/old.ts': '', 'host/new.ts': 'export function answer() { return 42; }' });
  assert.deepEqual(checkMoves({ repo: dir, before: 'before', after: 'after', moves: ['answer'] }).results,
    [{ move: 'answer', ok: true, detail: 'server/old.ts -> host/new.ts' }]);
});


test('shard proof accepts a complete repartition and rejects missing indexes or changed cases', t => {
  const helper = 'export function useShard() {}';
  const cases = "import { test } from './support/sharded-test';\ntest('one', () => {});\n";
  const entry = (index: number, count: number) => `useShard(${index}, ${count});\nrequire('./sample.cases');\n`;
  const dir = repo(t, { 'test/support/sharded-test.ts': helper, 'test/sample.cases.ts': cases,
    'test/sample-1.test.ts': entry(0, 2), 'test/sample-2.test.ts': entry(1, 2) }, {});
  rmSync(join(dir, 'test/sample-2.test.ts'));
  writeFileSync(join(dir, 'test/sample-1.test.ts'), entry(0, 1));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('add', '-A'); git('commit', '-qm', 'repartition');
  assert.match(checkShardMoves(dir, 'before', 'HEAD', ['sample'])[0]!, /2 -> 1 files/);
  writeFileSync(join(dir, 'test/sample-1.test.ts'), entry(1, 2));
  git('add', '-A'); git('commit', '-qm', 'missing');
  assert.throws(() => checkShardMoves(dir, 'before', 'HEAD', ['sample']), /incomplete shard layout/);
  writeFileSync(join(dir, 'test/sample-1.test.ts'), entry(0, 1));
  writeFileSync(join(dir, 'test/sample.cases.ts'), cases.replace("'one'", "'changed'"));
  git('add', '-A'); git('commit', '-qm', 'changed');
  assert.throws(() => checkShardMoves(dir, 'before', 'HEAD', ['sample']), /case registrations changed/);
});


test('moves into each current runtime owner remain visible to the checker', t => {
  for (const owner of ['core', 'service', 'hosts']) {
    const source = 'export function answer() { return 42; }';
    const dir = repo(t, { 'server/old.ts': source }, { 'server/old.ts': '' });
    mkdirSync(join(dir, owner));
    writeFileSync(join(dir, owner, 'new.ts'), source);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'relocate']);
    const result = checkMoves({ repo: dir, before: 'before', after: 'HEAD', moves: ['answer'] });
    assert.deepEqual(result.results, [{ move: 'answer', ok: true, detail: `server/old.ts -> ${owner}/new.ts` }]);
  }
});
