import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';

function fixture(t: TestContext) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'projects-cache-')), 'queue.sqlite'));
  t.after(() => store.close());
  store.upsertProject({ key: 'suite', name: 'Suite', repositories: [{ origin: 'acme/suite', path: '/fixture/suite' }] });
  return store;
}

test('project reads parse once, return detached values and ignore unrelated writes', t => {
  const store = fixture(t);
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (text: string, ...args: []) => {
    if (text.includes('"name":"Suite"')) parses++;
    return parse(text, ...args);
  });
  const first = store.projects();
  first[0].name = 'caller mutation';
  first[0].repositories[0].path = '/changed';
  store.event('unrelated', 'test', 'not a project write');
  assert.equal(store.projects()[0].name, 'Suite');
  assert.equal(store.projects()[0].repositories[0].path, '/fixture/suite');
  assert.equal(parses, 1);
  store.setProjectVisibility({ key: 'suite', version: 1 }, 'parked');
  assert.equal(store.projects()[0].visibility, 'parked');
  assert.equal(parses, 2);
});

test('project cache observes direct writes and deletion', t => {
  const store = fixture(t);
  const project = store.projects()[0];
  store.db.prepare('UPDATE projects SET data=? WHERE key=?').run(JSON.stringify({ ...project, name: 'Direct' }), project.key);
  assert.equal(store.projects()[0].name, 'Direct');
  store.db.prepare('DELETE FROM projects WHERE key=?').run(project.key);
  assert.deepEqual(store.projects(), []);
});

test('rollback drops uncommitted cache even when a later write reuses its clock', t => {
  const store = fixture(t);
  const project = store.projects()[0];
  assert.throws(() => store.transaction(() => {
    store.db.prepare('UPDATE projects SET data=? WHERE key=?').run(JSON.stringify({ ...project, name: 'Rolled back' }), project.key);
    assert.equal(store.projects()[0].name, 'Rolled back');
    throw new Error('rollback');
  }), /rollback/);
  // Do not read between rollback and the next write: its clock equals the cached one.
  store.db.prepare('UPDATE projects SET data=? WHERE key=?').run(JSON.stringify({ ...project, name: 'Committed' }), project.key);
  assert.equal(store.projects()[0].name, 'Committed');
});
