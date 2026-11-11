import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';

test('store admission checks integrity once and standalone schema inspection still checks it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hot-reads-')), 'queue.sqlite');
  new Store(path).close();
  const original = DatabaseSync.prototype.prepare;
  let checks = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (sql === 'PRAGMA quick_check(1)') checks++;
    return original.call(this, sql);
  };
  try {
    new Store(path).close();
    assert.equal(checks, 1);
    Store.storedSchema(path);
    assert.equal(checks, 2);
  } finally { DatabaseSync.prototype.prepare = original; }
});

test('prepared hot reads stay current through writes and rollback without preparing again', () => {
  const store = new Store(':memory:');
  const original = store.db.prepare.bind(store.db);
  let prepares = 0;
  store.db.prepare = sql => { prepares++; return original(sql); };
  try {
    store.getMeta('hot'); store.laneViewRevision();
    const warmed = prepares;
    store.getMeta('hot'); store.laneViewRevision();
    assert.equal(prepares, warmed);
    store.setMeta('hot', 'before');
    assert.throws(() => store.transaction(() => {
      store.setMeta('hot', 'inside');
      assert.equal(store.getMeta('hot'), 'inside');
      throw new Error('refused');
    }), /refused/);
    assert.equal(store.getMeta('hot'), 'before');
  } finally { store.close(); }
});

test('pending cards use indexed identity probes and include review entry while excluding bound and settled submissions', () => {
  const store = new Store(':memory:');
  try {
    const accept = (id: string, kind: 'submit' | 'review_entry') => {
      const submission = submissionSchema.parse({ submissionId: id, title: id, repoPath: '/fixture/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' });
      return store.acceptOperation({ key: id, kind, inputHash: 'a'.repeat(64), payload: { submission }, submissionId: id, repoPath: submission.repoPath });
    };
    accept('new', 'submit'); accept('review', 'review_entry'); accept('bound', 'submit'); accept('purged', 'submit');
    store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run('task', 'bound', 'hash', '{}');
    store.db.prepare('INSERT INTO tombstones VALUES(?,?,?,?)').run('tombstone', 'purged', 'hash', '{}');
    assert.deepEqual(store.pendingSubmissions().map(card => card.submissionId), ['new', 'review']);
    const original = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
      assert.doesNotMatch(sql, /SELECT submission FROM (tasks|tombstones)/);
      return original(sql);
    };
    store.db.exec("UPDATE operations SET state='succeeded'");
    assert.deepEqual(store.pendingSubmissions(), []);
  } finally { store.close(); }
});

test('paused resume counts read the partial index and retain distinct agents and episode boundaries', () => {
  const store = new Store(':memory:');
  try {
    const insert = store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)');
    insert.run('t', '2026-11-08', 'paused_resume', '{"agentId":"old"}');
    for (const agent of ['a', 'a', 'b']) insert.run('t', '2026-11-09', 'paused_resume', JSON.stringify({ agentId: agent }));
    insert.run('t', '2026-11-09', 'other', '{"agentId":"other"}');
    const sql = "SELECT COUNT(DISTINCT json_extract(detail,'$.agentId')) AS n FROM events WHERE kind='paused_resume' AND at >= ?";
    assert.equal(store.db.prepare(sql).get('2026-11-09')?.n, 2);
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('2026-11-09');
    assert.match(JSON.stringify(plan), /events_paused_resume/);
  } finally { store.close(); }
});
