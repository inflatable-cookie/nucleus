import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewMarker,reviewPublicationBody} from '../core/forge/index';
import type {Task,Run} from '../shared/contracts';
const task={id:'task'} as Task,run={id:'run',head:'a'.repeat(40)} as Run;
const marker=reviewMarker(task,run.id,run.head,'ready_to_merge');
test('publication preserves an exact supplied marker and substantive verdict byte for byte',()=>{
  const text=`Approval: ${marker}\n\nVerdict: ready to merge.\n\nResidual finding: preserve the caveat.`;
  assert.equal(reviewPublicationBody(task,run,'ready_to_merge',text),text);
  assert.equal(reviewPublicationBody(task,run,'ready_to_merge',reviewPublicationBody(task,run,'ready_to_merge',text)),text);
});
test('markerless review gets one canonical marker; foreign, duplicate and empty findings are rejected',()=>{
  assert.equal(reviewPublicationBody(task,run,'ready_to_merge','Findings'),`Findings\n\n${marker}`);
  for(const wrong of [marker.replace('task','other'),marker.replace(':run:',':other:'),marker.replace(run.head,'b'.repeat(40)),marker.replace('ready_to_merge','changes_required'),`${marker}\n${marker}`])assert.throws(()=>reviewPublicationBody(task,run,'ready_to_merge',`Findings\n${wrong}`),/must exactly match/);
  assert.throws(()=>reviewPublicationBody(task,run,'ready_to_merge',marker),/substantive/);
});
