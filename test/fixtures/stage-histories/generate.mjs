// Regenerate with Node from this directory. Every value comes from this synthetic scenario.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const digest = label => createHash('sha256').update(`synthetic-stage:${label}`).digest('hex');
const uuid = label => { const h = digest(label); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const head = label => digest(label).slice(0,40);
const at = index => new Date(Date.UTC(2000, 0, 1, 0, index)).toISOString();
const stages = ['prepare', 'canonical', 'verifier', 'publisher', 'terminal'];
function scenario(number, closed) {
  const label = `scenario-${number}`;
  const taskId = uuid(label);
  const currentHead = head(`${label}:current`);
  const priorHead = head(`${label}:prior`);
  const subjectId = digest(`${label}:subject`);
  const verdictSetId = digest(`${label}:verdicts`);
  const gate = { pass: Array.from({length: 36}, (_, i) => `requirement-${i + 1}`), insufficient: Array.from({length: 30}, (_, i) => `optional-${i + 1}`) };
  const run = (id, stageId, status, runHead = currentHead) => {
    const runId = uuid(`${label}:${id}`);
    return {id: runId, role: stageId === 'prepare' ? 'worker' : stageId === 'publisher' ? 'publisher' : 'reviewer', stageId, head: runHead, base: head(`${label}:base`), agentId: uuid(`${label}:agent:${id}`), workspaceId: `fixture-${id}`, released: true, status, briefVersion: 1,
      completion: {eventId: digest(`${label}:report:${id}`), taskId, runId, status, head: runHead, ...(stageId === 'prepare' ? {} : {verdictSetId})}};
  };
  const runs = closed
    ? [...Array.from({length: 3}, (_, i) => run(`retry-${i}`, 'canonical', 'ready_for_review')), ...stages.map(s => run(s, s, 'ready_for_review'))]
    : [run('blocked-publisher', 'publisher', 'blocked', priorHead), run('accepted-publisher', 'publisher', 'ready_for_review', priorHead), run('stale-worker', 'prepare', 'ready_for_review', priorHead), ...stages.map(s => run(s, s, 'ready_for_review'))];
  const reviews = runs.filter(r => r.role !== 'worker').map((r, index) => ({runId:r.id,agentId:r.agentId,head:r.head,status:r.status,reviewId:index+1,verdictSetId}));
  const records = stages.slice(0, closed ? 5 : 4).map((stageId, index) => {
    const runId = uuid(`${label}:${!closed && stageId === 'publisher' ? 'blocked-publisher' : stageId}`);
    const r = runs.find(row => row.id === runId);
    return {stageId,index,kind:stageId === 'prepare' ? 'work' : stageId === 'publisher' ? 'publish' : 'review',
      runId:r.id,agentId:r.agentId,status:r.status === 'blocked' ? 'blocked' : 'satisfied',subjectId,verdictSetId,
      reviewId:reviews.find(review => review.runId === r.id)?.reviewId ?? null,at:at(index)};
  });
  return {format:'synthetic-stage-history-v1',capturedAt:at(0),provenance:{taskId,taskNumber:number,taskVersion:1,taskRowSha256:digest(`${label}:row`),source:'generated synthetic scenario; no consumer records'},
    task:{id:taskId,number,phase:closed?'done':'awaiting_review',version:1,prHead:currentHead,agentId:uuid(`${label}:worker`),workspaceId:'fixture-workspace'},
    completion:closed ? runs.at(-1).completion : runs[2].completion,mergedCommit:closed?head(`${label}:merged`):null,
    briefVersions:[{version:1,digest:`sha256:${digest(`${label}:brief`)}`,plan:{goal:true,stages:stages.map((id,index)=>({id,kind:id === 'prepare' ? 'work' : id === 'publisher' ? 'publish' : 'review',role:runs.find(r=>r.stageId===id).role,subjectId,independence:index?[stages[index-1]]:[],gate:id==='canonical'?gate:{pass:[],insufficient:[]},actions:id==='publisher'?['publish']:['comment'],wait:[]}))}}],
    stageState:{currentIndex:closed?5:3,records,history:[],invalidations:[{at:at(6),reason:closed?'digest_changed at prepare':'head_changed',index:0,stageId:'prepare',records:[records[0]]}]},
    reviews,runs,events:runs.map((r,index)=>({id:index+1,kind:'agent_report',at:at(index),detailSha256:digest(`${label}:event:${index}`),identities:[r.id,r.completion.eventId],...(index===0&&closed?{decision:'digest_changed at prepare'}:{})})),
    tables:{subjects:{[subjectId]:{head:currentHead,digests:[{path:'docs/example/source.md',sha256:digest(`${label}:document`)}]}},verdictSets:{[verdictSetId]:gate.pass.map(id=>({id,verdict:'pass',evidenceSha256:digest(`${label}:${id}`),evidenceBytes:64}))}}};
}
const first = scenario(1001, true), second = scenario(1002, false);
const base = head('shape:base'), publication = second.completion.head, incoming = head('shape:incoming');
const sizes = {common:70000,publication:72001,incoming:74000,candidate:76002};
const heads = {common:base,publication,incoming,candidate:second.task.prHead};
const shape = {format:'synthetic-stage-git-shape-v1',taskId:second.task.id,path:'docs/example/source.md',candidate:second.task.prHead,parents:[publication,incoming],common:base,
  objects:Object.fromEntries(Object.entries(sizes).map(([key, bytes])=>[key,{head:heads[key],blob:head(`shape:blob:${key}`),bytes,sha256:digest(`shape:bytes:${key}`),terminalLF:key!=='incoming'}])),
  owningDocumentProofExpectation:{unionBytes:76001,candidateBytes:76002,allowedNormalization:'exactly one terminal LF',source:'synthetic append scenario'},deltaEntryCount:12,deltaPathEndpoints:14};
for (const [filename, value] of [['1001.json', first], ['1002.json', second], ['1002-git-shape.json', shape]]) writeFileSync(new URL(filename, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
