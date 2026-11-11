import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../core/store/store';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

const source = process.env.NUCLEUS_SNAPSHOT;
test('snapshot migration preserves recorded text digests and reclaims space', { skip: !source }, () => {
  assert.ok(source);
  const dir = mkdtempSync(join(tmpdir(), 'lean-text-snapshot-'));
  const path = join(dir, 'copy.sqlite');
  copyFileSync(source, path);
  const beforeSize = statSync(path).size;
  const db = new DatabaseSync(path, { readOnly: true });
  const leads = db.prepare("SELECT id,json_extract(data,'$.body') AS body FROM leads").all().map(row => [String(row.id), hash(String(row.body))] as const);
  const versions = db.prepare("SELECT leadId,version,json_extract(data,'$.body') AS body FROM lead_versions WHERE json_type(data,'$.body')='text'").all().map(row => [String(row.leadId), Number(row.version), hash(String(row.body))] as const);
  const tasks = db.prepare("SELECT id,data FROM tasks").all().map(row => {
    const data = JSON.parse(String(row.data));
    const texts = new Map(db.prepare('SELECT digest,text FROM task_texts WHERE taskId=?').all(String(row.id)).map(text => [String(text.digest), String(text.text)]));
    const handoff = data.handoffText ?? texts.get(data.handoffDigest);
    const brief = data.brief?.text ?? texts.get(data.brief?.digest);
    return { id: String(row.id), handoff: typeof handoff === 'string' ? hash(handoff) : null, brief: typeof brief === 'string' ? hash(brief) : null };
  });
  const reviews = db.prepare("SELECT taskId,json_extract(data,'$.reviewText') AS text FROM task_reviews WHERE seq=0 AND json_type(data,'$.reviewText')='text'").all().map(row => [String(row.taskId), hash(String(row.text))] as const);
  db.close();
  const store = new Store(path, join(dir, 'backups'));
  for (const [id, expected] of leads) assert.equal(hash(store.lead(id).body), expected, `lead ${id}`);
  for (const [id, version, expected] of versions) assert.equal(hash(store.leadVersion(id, version).body), expected, `lead ${id} v${version}`);
  for (const item of tasks) {
    const task = store.task(item.id);
    if (item.handoff !== null) assert.equal(hash(task.handoffText), item.handoff, `handoff ${item.id}`);
    if (item.brief !== null) assert.equal(hash(task.brief!.text), item.brief, `brief ${item.id}`);
  }
  for (const [id, expected] of reviews) assert.equal(hash(store.task(id).resolution.review!.reviewText!), expected, `review ${id}`);
  store.close();
  const compact = new DatabaseSync(path); compact.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM'); compact.close();
  const afterSize = statSync(path).size;
  assert.ok(afterSize < beforeSize);
  process.stdout.write(`Snapshot bytes: before=${beforeSize} after=${afterSize} reclaimed=${beforeSize - afterSize}\n`);
});
