import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import { taskControlTelemetry } from '../core/telemetry/telemetry';
const day = 86400000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-telemetry-purge-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const add = (id: string) => store.insert(submissionSchema.parse({ submissionId:id,title:id,repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin' }), 'host', 'handoff', 'a'.repeat(40));
  return { store, add, close() { store.close(); rmSync(dir, {recursive:true,force:true}); } };
}
test('finished task history is kept exactly 4 days and purged one millisecond later (review #571)', () => {
  const f=fixture(); try {
    const task=f.add('boundary'); f.store.update(task.id,{phase:'done'});
    const finished=Date.parse(f.store.task(task.id).finishedAt!);
    assert.deepEqual(f.store.purgeOldTasks(finished+4*day),[]);
    assert.deepEqual(f.store.purgeOldTasks(finished+4*day+1),[task.id]);
  } finally { f.close(); }
});
test('repository-filtered control telemetry keeps a purged task through its durable outcome (review #571)', () => {
  const f=fixture(); try {
    const task=f.add('telemetry'); f.store.update(task.id,{phase:'done'});
    const old=new Date(Date.now()-5*day).toISOString();
    f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(old,task.id);
    f.store.recordVerbOutcome(task.id,'move','refused','coordinator',{reason:'example'});
    f.store.db.prepare('UPDATE verb_outcomes SET at=? WHERE taskId=?').run(old,task.id);
    const query={window:'7d',repoPath:'/repo'};
    assert.equal(taskControlTelemetry(f.store,query).coordinator.refused,1);
    assert.deepEqual(f.store.purgeOldTasks(),[task.id]);
    assert.equal(f.store.outcome(task.id)?.repository.path,'/repo');
    assert.equal(f.store.verbOutcomes('1970-01-01T00:00:00.000Z').length,1);
    assert.equal(taskControlTelemetry(f.store,{window:'7d'}).coordinator.refused,1);
    assert.equal(taskControlTelemetry(f.store,query).coordinator.refused,1,'the purged task still counts for its repository');
    assert.equal(taskControlTelemetry(f.store,{window:'7d',repoPath:'/other'}).coordinator.refused,0,'and not for another');
  } finally { f.close(); }
});
