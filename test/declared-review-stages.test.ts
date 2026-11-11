import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringify} from 'yaml';
import {parseNorthstarDocument,submissionQueueFields} from '../core/planning/handoff';

const work = {
  id:'prepare',kind:'work',subject:{head:'candidate',digests:[{path:'inputs/source.json'}]},
  role:'worker',independence:[],gate:{pass:[],insufficient:[]},actions:['push'],
  wait:[{kind:'source_rights',name:'confirm source permission'}],
};
const review = {
  id:'final-review',kind:'review',subject:{head:'candidate',digests:[{path:'inputs/source.json'}]},
  role:'reviewer',independence:['prepare'],gate:{pass:['source-check'],insufficient:['optional-note']},
  actions:['comment'],wait:[{kind:'operator',name:'confirm release'}],
};
const brief = (stages?:unknown) => stringify({
  title:'Stage schema fixture',queue_approval:'Approved for schema test',
  ...(stages===undefined?{}:{queue:{stages:Array.isArray(stages)?stages.map(stage=>JSON.parse(JSON.stringify(stage))):stages}}),
}).replace(/^/, '---\n').replace(/$/, '---\n\nA brief body.\n');
const parsedBrief = (stages:unknown) => parseNorthstarDocument(brief(stages),'brief');
const rejectedAs = (stages:unknown,message:string) => assert.throws(
  ()=>parsedBrief(stages),error=>{
    assert.equal((error as Error).message,`Invalid brief frontmatter: ${message}`);
    return true;
  },
);

test('Spec 043 step b accepts complete declarations with review or verify as the terminal stage',()=>{
  const publish={
    id:'publish',kind:'publish',subject:{head:'candidate',digests:[]},role:'publisher',
    independence:['prepare'],gate:{pass:['source-check'],insufficient:[]},
    actions:[{publish:'registered-release'}],
    evidence:{pins:[{name:'source-receipt',sha256:'a'.repeat(64)}],maxRuns:1},wait:[],
  };
  const reviewed=parsedBrief([work,publish,review]);
  assert.deepEqual(reviewed.queue.stages?.map(stage=>stage.kind),['work','publish','review']);
  const verified={...review,id:'final-verify',kind:'verify',actions:['push','comment']};
  assert.equal(parsedBrief([work,verified]).queue.stages?.at(-1)?.kind,'verify');
});

test('Spec 043 brief stages stay in brief text and are omitted from submission queue fields',()=>{
  const withStages=parsedBrief([work,review]);
  assert.ok(withStages.queue.stages);
  const submissionFields=submissionQueueFields(withStages.queue as unknown as Parameters<typeof submissionQueueFields>[0]);
  assert.equal(Object.hasOwn(submissionFields,'stages'),false);
  assert.match(brief([work,review]),/stages:/);

  const legacy=parseNorthstarDocument(`---\n${stringify({title:'Legacy brief',queue_approval:'Approved',queue:{scope:'mechanical'}})}---\nBody.\n`,'brief');
  assert.equal(Object.hasOwn(legacy.queue,'stages'),false);
  assert.deepEqual(submissionQueueFields(legacy.queue as unknown as Parameters<typeof submissionQueueFields>[0]),
    {dependsOn:[],scope:'mechanical',completionNotificationAgentIds:[],lanes:[]});
});

test('Spec 043 rejects duplicate ids and a non-review terminal stage with exact errors',()=>{
  rejectedAs([],'queue.stages: Too small: expected array to have >=1 items');
  rejectedAs([work,{...review,id:'prepare'}],'queue.stages.1.id: Stage ids must be unique');
  rejectedAs([work,{...work,id:'last-work'}],'queue.stages.1.kind: The last stage must be review or verify');
});

test('Spec 043 independence is unique and may reference only earlier stages',()=>{
  rejectedAs([{...work,independence:['final-review']},review],'queue.stages.0.independence.0: Independence may reference only earlier stages');
  rejectedAs([work,{...review,independence:['prepare','prepare']}],'queue.stages.1.independence.1: Independence stage ids must be unique');
});

test('Spec 043 subject paths are normalized and unique',()=>{
  rejectedAs([{...work,subject:{head:'candidate',digests:[{path:'../secret'}]}},review],
    'queue.stages.0.subject.digests.0.path: Path must be a normalized repository-relative path');
  rejectedAs([{...work,subject:{head:'candidate',digests:[{path:'same.txt'},{path:'same.txt'}]}},review],
    'queue.stages.0.subject.digests.1.path: Subject digest paths must be unique');
});

test('Spec 043 gate verdict ids are unique and cannot be both pass and insufficient',()=>{
  rejectedAs([{...work,gate:{pass:['same','same'],insufficient:[]}},review],
    'queue.stages.0.gate.pass.1: Gate verdict ids must be unique');
  rejectedAs([{...work,gate:{pass:['same'],insufficient:['same']}},review],
    'queue.stages.0.gate.insufficient.0: A verdict id cannot be both required to pass and permitted insufficient');
});

test('Spec 043 evidence pins are unique and limited to one run',()=>{
  rejectedAs([{...work,evidence:{pins:[],maxRuns:1}},review],
    'queue.stages.0.evidence.pins: Evidence must include at least one pin');
  rejectedAs([{...work,evidence:{pins:[{name:'source',sha256:'a'.repeat(64)},{name:'source',sha256:'b'.repeat(64)}],maxRuns:1}},review],
    'queue.stages.0.evidence.pins.1.name: Evidence pin names must be unique');
  rejectedAs([{...work,evidence:{pins:[{name:'source',sha256:'a'.repeat(64)}],maxRuns:2}},review],
    'queue.stages.0.evidence.maxRuns: Invalid input: expected 1');
  rejectedAs([{...work,evidence:{pins:[{name:'source',sha256:'not-a-sha256'}],maxRuns:1}},review],
    'queue.stages.0.evidence.pins.0.sha256: Invalid string: must match pattern /^[a-f0-9]{64}$/');
});

test('Spec 043 rejects unsupported kinds, empty or unknown actions, unnamed waits and unknown fields',()=>{
  rejectedAs([{...work,kind:'build'},review],
    'queue.stages.0.kind: Invalid option: expected one of "work"|"review"|"verify"|"publish"');
  rejectedAs([{...work,actions:[]},review],
    'queue.stages.0.actions: A stage must permit at least one action');
  rejectedAs([{...work,actions:['delete']},review],'queue.stages.0.actions.0: Invalid input');
  rejectedAs([{...work,wait:[{kind:'operator',name:''}]},review],
    'queue.stages.0.wait.0.name: Too small: expected string to have >=1 characters');
  rejectedAs([{...work,wait:[{kind:'unknown',name:'wait'}]},review],
    'queue.stages.0.wait.0.kind: Invalid option: expected one of "operator"|"source_rights"');
  rejectedAs([{...work,subject:{head:'latest',digests:[]}},review],
    'queue.stages.0.subject.head: Invalid input: expected "candidate"');
  rejectedAs([{...work,role:'   '},review],
    'queue.stages.0.role: Too small: expected string to have >=1 characters');
  rejectedAs([{...work,extra:true},review],'queue.stages.0: Unrecognized key: "extra"');
});

test('Spec 043 a stage profile is schema-checked and only review or verify stages may declare one',()=>{
  const verify={...review,id:'final-verify',kind:'verify',profile:{id:'deepseek',reason:'Fresh verifier on a different model'}};
  assert.deepEqual(parsedBrief([work,verify]).queue.stages?.at(-1)?.profile,{id:'deepseek',reason:'Fresh verifier on a different model'});
  assert.deepEqual(parsedBrief([work,{...review,profile:{id:'deepseek',reason:'Fresh verifier'}}]).queue.stages?.at(-1)?.profile,{id:'deepseek',reason:'Fresh verifier'},
    'a review stage may name a profile too');
  rejectedAs([{...work,profile:{id:'deepseek',reason:'Fresh verifier'}},verify],
    'queue.stages.0.profile: Only a review or verify stage may name a profile');
  rejectedAs([work,{...review,profile:{id:'deepseek'}}],
    'queue.stages.1.profile.reason: Invalid input: expected string, received undefined');
  rejectedAs([work,{...review,profile:{id:'deepseek',reason:'   '}}],
    'queue.stages.1.profile.reason: Too small: expected string to have >=1 characters');
  rejectedAs([work,{...review,profile:{id:'deepseek',reason:'Fresh verifier',extra:true}}],
    'queue.stages.1.profile: Unrecognized key: "extra"');
});

test('Spec 043 goal gate schema accepts named verdict ids or the terminal gate, and requires stages',()=>{
  const briefWith=(queue:Record<string,unknown>)=>parseNorthstarDocument(
    `---\n${stringify({title:'Goal fixture',queue_approval:'Approved',queue})}---\n\nA brief body.\n`,'brief');
  assert.deepEqual(briefWith({stages:[work,review],goal:['source-check']}).queue.goal,['source-check']);
  assert.equal(briefWith({stages:[work,review],goal:true}).queue.goal,true);
  assert.throws(()=>briefWith({goal:['source-check']}),
    /Invalid brief frontmatter: queue.goal: queue.goal requires queue.stages \(Spec 043\)/);
  assert.throws(()=>briefWith({stages:[work,review],goal:[]}),
    /Invalid brief frontmatter: queue.goal: Too small/);
  assert.throws(()=>briefWith({stages:[work,review],goal:'source-check'}),
    /Invalid brief frontmatter: queue.goal: Invalid input/);
});

test('retired root review keys are refused on any brief, staged or not',()=>{
  const briefWith=(queue:Record<string,unknown>)=>parseNorthstarDocument(
    `---\n${stringify({title:'Staged gate fixture',queue_approval:'Approved',queue})}---\n\nA brief body.\n`,'brief');
  assert.throws(()=>briefWith({stages:[work,review],reviewVerdicts:['source-check']}),
    /Invalid brief frontmatter: queue.reviewVerdicts: queue.reviewVerdicts is no longer available/);
  assert.throws(()=>briefWith({stages:[work,review],reviewVerdicts:true}),
    /Invalid brief frontmatter: queue.reviewVerdicts: queue.reviewVerdicts is no longer available/);
  assert.throws(()=>briefWith({stages:[work,review],reviewPassGate:['source-check']}),
    /Invalid brief frontmatter: queue.reviewPassGate: queue.reviewPassGate is no longer available/);
  assert.throws(()=>briefWith({reviewPassGate:['body']}),
    /Invalid brief frontmatter: queue.reviewPassGate: queue.reviewPassGate is no longer available/);
  assert.throws(()=>briefWith({reviewVerdicts:['body']}),
    /Invalid brief frontmatter: queue.reviewVerdicts: queue.reviewVerdicts is no longer available/);
  // queue.reviewContinuationIds is retired and inert: it parses even on a staged
  // brief and grants no stage-callback behaviour.
  assert.deepEqual(briefWith({stages:[work,review],reviewContinuationIds:['source-check']}).queue.reviewContinuationIds,['source-check']);
  // A staged brief without retired keys still parses.
  assert.ok(briefWith({stages:[work,review]}).queue.stages);
});
