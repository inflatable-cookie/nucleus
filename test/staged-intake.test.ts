import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { Store, submissionHash } from '../core/store/store';
import { STEPS_RETIRED_REASON } from '../core/recovery/retired-steps';
import { stageDeclarationFromBrief } from '../core/stages';
import { submissionSchema } from '../shared/contracts';

const base = 'b'.repeat(40);
const staged = `---\n${stringify({ queue: { stages: [{ id: 'final-review', kind: 'review', role: 'reviewer', subject: { head: 'candidate', digests: [] },
  independence: [], gate: { pass: [], insufficient: [] }, actions: ['comment'], wait: [] }] } })}---\n# Staged brief\n`;
const submission = (text: string) => submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base,
  handoffPath: 'handoff.md', originAgentId: 'origin', brief: { text } });

test('no intake path can create a task from a brief that declares stages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-staged-intake-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    assert.ok(stageDeclarationFromBrief(staged), 'the fixture is a real stage declaration');
    // Task creation is the one choke point every intake path reaches.
    assert.throws(() => store.insert(submission(staged), 'host', staged, base), new RegExp(STEPS_RETIRED_REASON.replace(/[.]/g, '\\.')));
    // Review entry preview and binding share this validation; it refuses before any approval lookup.
    assert.throws(() => store.validateReviewEntryBrief(submission(staged), 'example/repo'), /Declared steps are retired/);
    // A historical submission already stored returns its task on replay instead of throwing.
    const plain = submission('# Plain brief\n');
    const historical = { ...plain, brief: { text: staged, mediaType: 'text/markdown' as const } };
    const task = store.insert(plain, 'host', 'h', base);
    const row = store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id) as { data: string };
    const data = JSON.parse(row.data); data.brief = { ...data.brief, text: staged };
    store.db.prepare('UPDATE tasks SET data=?, input_hash=? WHERE id=?').run(JSON.stringify(data), submissionHash(historical), task.id);
    assert.equal(store.insert(historical, 'host', 'h', base).id, task.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
