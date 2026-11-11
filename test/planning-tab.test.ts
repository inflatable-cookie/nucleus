import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardSource } from './support/board-source';
import { planningColumns, planningPlan, reorderPlan, movePlan, projectPlanningCounts, roadmapView } from '../shared/planning-tab';
import type { LaneView, Lead, Project, ProjectPlan } from '../shared/contracts';

const entry = (lane:string,horizon:'now'|'next'|'later'='now') => ({lane,note:'',horizon});
const plan = (version:number,entries:ProjectPlan['entries']):ProjectPlan => ({project:'app',version,entries,author:null,createdAt:null});

test('Planning groups the current plan even when the saved-membership read lags',()=>{
  const latest=plan(1,[entry('first'),entry('second','later'),entry('joined')]);
  assert.deepEqual(planningPlan(latest,plan(1,latest.entries.slice(0,2)),['first','second','joined','not-planned']),{
    now:[entry('first'),entry('joined')],next:[],later:[entry('second','later')],unplanned:[entry('not-planned','later')],
  });
  assert.deepEqual(planningPlan(latest,plan(0,[])).now,[entry('first'),entry('joined')]);
});

test('026-14 Planning tab reorders and moves lanes with their horizon',()=>{
  const entries=[entry('first'),entry('second'),entry('third','later')];
  assert.deepEqual(reorderPlan(entries,'second',-1).map(item=>item.lane),['second','first','third']);
  assert.deepEqual(reorderPlan(entries,'first',-1),entries);
  assert.deepEqual(movePlan(entries,'third','now'),[entry('first'),entry('second'),entry('third')]);
  assert.deepEqual(movePlan(entries,'first','later'),[entry('second'),entry('third','later'),entry('first','later')]);
});

test('026-14a Planning tab has plan and lane columns wide and a plan-then-lane drill-down compact',()=>{
  assert.deepEqual(planningColumns(false,'lane'),['plan','lane']);
  assert.deepEqual(planningColumns(false,'plan'),['plan','lane']);
  assert.deepEqual(planningColumns(true,'plan'),['plan']);
  assert.deepEqual(planningColumns(true,'lane'),['lane']);
  const ui=boardSource();
  // PR #518's TypeScript formatting reformatted the surface; the slice bounds follow the shipped layout.
  // #866: the Lanes destination is folded into Planning, so the slice bounds follow the Tasks tab.
  const pipeline=ui.slice(ui.indexOf('{tab === "queue" && (\n        <View style={{ flex: 1, minHeight: 0, gap: 12, zIndex: 0 }}>'),ui.indexOf('          {task && ('));
  assert.doesNotMatch(pipeline,/Planning|Lane document|Save plan|planningLane/);
  assert.doesNotMatch(ui,/accessibilityLabel="Planning projects"/);
  assert.doesNotMatch(ui,/Back to projects/);
  const panel=readFileSync(new URL('../client/planning-panel.tsx',import.meta.url),'utf8');
  assert.match(panel,/accessibilityLabel="Planning plan"/);
  assert.match(panel,/accessibilityLabel="Planning lane"/);
  assert.match(panel,/Back to plan/);
  assert.doesNotMatch(panel,/picker/i);
  assert.match(panel,/action="add" label=\{`Add \$\{item.lane\} to \$\{name\} plan`\}/);
  assert.match(ui,/<PlanningTab\b/);
  assert.match(ui,/savePlan\(planSaveInput\(project,\s*edit,\s*"operator \(board\)"\)\)/);
  // #867: the lane screen sends the version its text was written against; queue.tsx saves it under the open lane.
  assert.match(ui,/saveLaneDocument\(\{\s*key:\s*planningLaneRecord\.key,\s*version,\s*text,\s*author:\s*"operator \(board\)"/);
  assert.match(readFileSync(new URL('../client/lane-screen.tsx',import.meta.url),'utf8'),/onSaveDocument\(\{ version: draft\.base, text: draft\.text \}\)/);
});

test('026-14 Planning projects show live tasks and open leads',()=>{
  const repo={origin:'owner/app',path:'/app'};
  const project={key:'app',name:'App',repositories:[repo],primary:repo};
  const counts=projectPlanningCounts(project as Parameters<typeof projectPlanningCounts>[0],[
    {repository:repo.origin,repoPath:repo.path,phase:'working'},
    {repository:repo.origin,repoPath:repo.path,phase:'done'},
  ] as Parameters<typeof projectPlanningCounts>[1],[
    {id:'l1',title:'L1',state:'open',lanes:[],repositories:[repo]},
    {id:'l2',title:'L2',state:'promoted',lanes:[],repositories:[repo]},
  ] as Parameters<typeof projectPlanningCounts>[2]);
  assert.deepEqual(counts,{tasks:1,leads:1});
});

test('041-1 roadmap view splits bands, counts tasks, leads and activity, and keeps the Drained flag empty',()=>{
  const lane=(key:string,live:number,done:number)=>({key,title:`T ${key}`,aim:`Aim ${key}`,liveByPhase:{working:live},terminalCount:done,lastActivityAt:'2026-10-02T10:00:00Z'}) as unknown as LaneView;
  const lead=(id:string,laneKey:string,state='open')=>({id,state,lanes:[laneKey]}) as unknown as Lead;
  const view=roadmapView({
    entries:[{...entry('a'),doneWhen:'Ships'},entry('b'),entry('c','next'),{...entry('d','later'),doneWhen:'x'}],
    unplanned:[entry('u')],
    done:[{...entry('old'),status:'done',closedAt:'2026-09-01T00:00:00Z'},{...entry('new'),status:'abandoned',closedAt:'2026-10-01T00:00:00Z'}],
    lanes:[lane('a',2,5),lane('b',0,0),lane('c',1,1),lane('d',0,0),lane('u',0,0)],
    leads:[lead('l1','a'),lead('l2','a','promoted'),lead('l3','c')],
  });
  assert.deepEqual([view.now.map(s=>s.lane),view.next.map(s=>s.lane),view.later.map(s=>s.lane)],[['a','b'],['c'],['d']]);
  assert.deepEqual([view.now[0].tasksLive,view.now[0].tasksDone,view.now[0].openLeads,view.now[0].lastActivityAt],[2,5,1,'2026-10-02T10:00:00Z']);
  assert.deepEqual(view.now.map(s=>s.doneWhenMissing),[false,true],'a now step without doneWhen is marked');
  assert.equal(view.next[0].doneWhenMissing,true);
  assert.equal(view.later[0].doneWhenMissing,false);
  assert.deepEqual(view.done.map(d=>d.lane),['new','old'],'newest close first');
  assert.deepEqual(view.unplanned.map(s=>s.lane),['u']);
  assert.ok([...view.now,...view.next,...view.later,...view.unplanned].every(s=>s.drained===null));
});

test('041-3 moves between Next and Now change the horizon',()=>{
  const entries=[entry('a'),entry('b','next'),entry('c','later')];
  assert.deepEqual(movePlan(entries,'b','now').map(e=>[e.lane,e.horizon]),[['a','now'],['b','now'],['c','later']]);
  assert.deepEqual(movePlan(entries,'a','next').map(e=>[e.lane,e.horizon]),[['b','next'],['a','next'],['c','later']]);
  assert.deepEqual(reorderPlan([entry('x','next'),entry('y','next')],'y',-1).map(e=>e.lane),['y','x']);
});

test('Planning uses the batched current plan and current lane projections',()=>{
  const ui=boardSource();
  assert.doesNotMatch(ui,/fetchPlan\(\{project:project\.key,version:/,'Planning does not fan out plan.get per project');
  assert.match(ui,/saved: latest \? \{ \.\.\.latest, entries: latest\.savedEntries \} : undefined/,'saved membership remains available for draft rebasing');
  assert.match(ui,/queryFn:\(\)=>fetchPlans\(\{\}\),enabled:\(tab==="planning"\|\|tab==="queue"\)&&Boolean\(state\?\.projects\.length\),staleTime:300_000,placeholderData:keepPreviousData\}\)/,'the batched plan read refetches on the plans revision (#1011), not a timer');
});

test('865 a draft is stale once the plan moves past its version; reapply keeps its horizons and drops lanes the plan no longer has', async () => {
  const { activeSteps, planDraftStale, rebaseDraft, sameOrder } = await import('../shared/planning-tab');
  assert.equal(planDraftStale(4, plan(4, [])), false);
  assert.equal(planDraftStale(4, plan(5, [])), true);
  assert.equal(planDraftStale(4, undefined), false);
  assert.deepEqual(activeSteps([entry('a', 'now'), entry('b', 'next'), entry('c', 'later')]).map(item => item.lane), ['a', 'b']);
  assert.equal(sameOrder([entry('a'), entry('b', 'later')], [entry('a'), entry('b', 'later')]), true);
  assert.equal(sameOrder([entry('a'), entry('b', 'later')], [entry('b', 'later'), entry('a')]), false, 'order matters');
  assert.equal(sameOrder([entry('a')], [entry('a', 'later')]), false, 'a horizon change is a change');
  const base = [{ ...entry('a'), note: 'new note', doneWhen: 'new done' }, entry('c', 'later'), entry('d', 'later')];
  const draft = [entry('c', 'now'), entry('gone'), entry('a', 'next')];
  assert.deepEqual(rebaseDraft(draft, base), [
    { ...base[1], horizon: 'now' }, { ...base[0], horizon: 'next' }, base[2],
  ], 'draft order and horizons win, the newer note and completion condition come along, and new lanes follow');
});

test('865 the save payload carries idle only when the draft sets a new mark; an unchanged mark is never renewed', async () => {
  const { planSaveInput } = await import('../shared/planning-tab');
  const draft = { entries: [entry('a', 'later'), entry('b', 'later')], version: 7 };
  assert.deepEqual(planSaveInput('app', draft, 'operator (board)'), { project: 'app', version: 7, entries: draft.entries, author: 'operator (board)' });
  assert.deepEqual(planSaveInput('app', { ...draft, idle: null }, 'operator (board)'), { project: 'app', version: 7, entries: draft.entries, author: 'operator (board)' }, 'ending a mark sends no mark');
  assert.deepEqual(planSaveInput('app', { ...draft, idle: 'Waiting for gaps' }, 'operator (board)'), { project: 'app', version: 7, entries: draft.entries, idle: 'Waiting for gaps', author: 'operator (board)' });
});
