import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { mount, useNativeStubs } from './support/render';
import type { LaneView, LeadListFacts, Project, ProjectPlan } from '../shared/contracts';
import type { PlanEdit, PlanSection } from '../client/planning-panel';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (key: string): Project => ({ key, name: key, repositories: [repo(key)], primary: repo(key), owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-10-03T00:00:00.000Z', note: '' } }) as Project;
const projects = [project('alpha'), project('beta'), project('gamma')];
const entry = (lane: string, horizon: 'now' | 'next' | 'later', doneWhen?: string) => ({ lane, note: '', horizon, ...(doneWhen ? { doneWhen } : {}) });
const lane = (key: string) => ({ key, title: `Title ${key}`, aim: `Aim ${key}`, repositories: [repo('alpha')], liveByPhase: { working: 1 }, terminalCount: 3, lastActivityAt: '2026-10-02T10:00:00Z' }) as unknown as LaneView;
const latest: ProjectPlan = {
  project: 'alpha', version: 4, author: null, createdAt: null,
  entries: [entry('n1', 'now', 'Ship it'), entry('n2', 'now'), entry('x1', 'next', 'Then this'), entry('l1', 'later'), entry('joined', 'now')],
  done: [{ ...entry('d-old', 'now'), status: 'done', closedAt: '2026-09-01T00:00:00Z' }, { ...entry('d-new', 'later'), status: 'abandoned', closedAt: '2026-10-01T00:00:00Z' }],
};
const saved: ProjectPlan = { ...latest, entries: latest.entries.slice(0, 4) };
const lanes = ['n1', 'n2', 'x1', 'l1', 'joined', 'unplanned', 'd-old', 'd-new'].map(lane);

type MountOver = { sections?: PlanSection[]; compact?: boolean; saveErrors?: Record<string, string>; onRetryPlans?: () => void; plansError?: string; lanesLoading?: boolean; lanesError?: string; lanes?: LaneView[]; leads?: LeadListFacts[] };

async function mountTab(over: MountOver = {}) {
  const { PlanningTab } = await import('../client/planning-panel');
  const log = { saves: [] as Array<[string, PlanEdit]>, closed: [] as string[] };
  function Harness() {
    const [edits, setEdits] = useState<Record<string, PlanEdit>>({});
    return h(PlanningTab, {
      sections: over.sections ?? [{ project: projects[0], latest, saved }],
      lanes, leads: over.leads ?? [], edits, selectedLane: '', step: 'plan', compact: false, busy: false, lanePanel: null,
      onStep: () => {}, onOpenLane: () => {},
      onEdit: (p: string, edit: PlanEdit) => setEdits(prev => ({ ...prev, [p]: edit })),
      onSave: (p: string, edit: PlanEdit) => log.saves.push([p, edit]), onCancel: () => setEdits({}), onCloseLane: (l: string) => log.closed.push(l), c, ...over,
    });
  }
  return { ui: mount(h(Harness)), log };
}

test('041-1 rendered: one project in scope shows its roadmap; several show compact rows, one expanded at a time; no selector', async () => {
  const one = (await mountTab()).ui;
  assert.ok(one.get('Plan for alpha'));
  assert.doesNotMatch(one.text(), /project planner missing/, 'the planner gap is the Projects problem icon now');
  assert.equal(one.query(/^Project row /), undefined);
  assert.equal(one.query(/^Plan project /), undefined);
  const many = (await mountTab({ lanes: lanes.map(item => item.key === 'n1' ? { ...item, liveByPhase: { blocked: 2 } } : item), sections: [{ project: projects[0], latest, saved }, { project: projects[1] }, { project: projects[2] }] })).ui;
  assert.equal(many.all(/^Project row /).length, 3);
  assert.equal(many.query(/^Plan for /), undefined, 'rows start collapsed');
  assert.match(many.text(), /Aim n1/, 'the row names the current aim');
  assert.match(many.text(), /2 need attention/, 'the row promotes the server-reported blocked total');
  assert.doesNotMatch(many.text(), /\d+ now · \d+ next · \d+ later · \d+ live/, 'the row does not lead with repeated counts');
  assert.equal(many.query(/^Plan project /), undefined, 'no selector in the tab');
  many.press('Project row alpha');
  assert.ok(many.get('Plan for alpha'));
  many.press('Project row beta');
  assert.deepEqual(many.all(/^Plan for /).map(node => node.props.accessibilityLabel), ['Plan for beta']);
  many.press('Project row beta');
  assert.equal(many.query(/^Plan for /), undefined);
});

test('all-projects rows render each project plan and counts, and Views contain no raw text children', async () => {
  const betaLatest: ProjectPlan = { ...latest, project: 'beta', version: 7, entries: [entry('b1', 'now'), entry('b2', 'next'), entry('b3', 'later')] };
  const betaLanes = ['b1', 'b2', 'b3'].map(lane);
  const longName = 'Beta project with a deliberately long accessible name';
  const longTitle = 'Lane title that remains readable in a narrow project row';
  const leads: LeadListFacts[] = [
    { id: 'alpha-lead', title: 'Alpha lead', state: 'open', lanes: ['n1'], repositories: [repo('alpha')] },
    { id: 'beta-lead', title: 'Beta lead', state: 'open', lanes: ['b2'], repositories: [repo('beta')] },
  ];
  betaLanes[0] = { ...betaLanes[0], title: longTitle };
  for (const compact of [false, true]) {
    const { ui } = await mountTab({ compact, lanes: [...lanes, ...betaLanes], leads, sections: [
      { project: projects[0], latest, saved },
      { project: { ...projects[1], name: longName }, latest: betaLatest, saved: betaLatest },
    ] });
    assert.match(ui.text(), /Aim n1/);
    assert.doesNotMatch(ui.text(), /\d+ now · \d+ next · \d+ later · \d+ live/);
    assert.equal(ui.get('Project row alpha').props.accessibilityRole, 'button');
    assert.ok(ui.get(`Project row ${longName}`));
    for (const view of ui.ofType('View'))
      assert.equal(view.children.some(child => typeof child === 'string'), false, `raw text child under View ${view.props.accessibilityLabel ?? ''}`);
  }
});

test('all-projects rows keep loading and failed reads distinct from an empty plan', async () => {
  const sections: PlanSection[] = [{ project: projects[0] }, { project: projects[1] }];
  const loading = (await mountTab({ sections })).ui;
  assert.equal(loading.all(/^Loading plan for /).length, 2);
  assert.doesNotMatch(loading.text(), /No now step|0 now · 0 next/);
  const betaLatest: ProjectPlan = { ...latest, project: 'beta', version: 7, entries: [entry('b1', 'now')] };
  const laneLoading = (await mountTab({
    sections: [{ project: projects[0], latest, saved }, { project: projects[1], latest: betaLatest, saved: betaLatest }],
    lanesLoading: true,
  })).ui;
  assert.equal(laneLoading.all(/^Loading plan for /).length, 2, 'known plans still wait for the lane facts used by their counts');
  assert.doesNotMatch(laneLoading.text(), /No now step|0 now · 0 next/);
  let retries = 0;
  const failed = (await mountTab({ sections: sections.map(section => ({ ...section, error: 'plans request failed' })), onRetryPlans: () => retries++ })).ui;
  assert.equal(failed.all(/^Plan unavailable for /).length, 2);
  assert.match(failed.text(), /Couldn’t load the plan: plans request failed/);
  assert.doesNotMatch(failed.text(), /No now step|0 now · 0 next/);
  failed.press('Retry plan and lane reads for alpha');
  assert.equal(retries, 1);
  const laneFailure = (await mountTab({ sections: [{ project: projects[0], latest, saved }, { project: projects[1], latest: betaLatest, saved: betaLatest }], lanesError: 'queue.snapshot failed', onRetryPlans: () => retries++ })).ui;
  assert.equal(laneFailure.all(/^Plan unavailable for /).length, 2);
  assert.match(laneFailure.text(), /Couldn’t load lanes: queue\.snapshot failed/);
  assert.doesNotMatch(laneFailure.text(), /No now step|0 now · 0 next/);
});

test('041-2 rendered: four bands, Done collapsed, unplanned lanes tucked away', async () => {
  const { ui } = await mountTab();
  for (const band of ['Now band', 'Next band', 'Later band']) assert.ok(ui.get(band));
  assert.ok(ui.get('Now step n1'));
  assert.ok(ui.get('Next step x1'));
  assert.ok(ui.get('Later step l1'));
  assert.match(ui.text(), /Aim n1/);
  assert.match(ui.text(), /Done when: Ship it/);
  assert.match(ui.text(), /3 done · 1 live · 0 open leads/);
  assert.ok(ui.get('Done band'));
  assert.match(ui.text(), /Done · 2/);
  assert.equal(ui.query('Done step d-old'), undefined, 'Done starts collapsed');
  ui.press('Done, 2');
  assert.deepEqual(ui.all(/^Done step /).map(node => node.props.accessibilityLabel), ['Done step d-new', 'Done step d-old']);
  assert.match(ui.text(), /abandoned · 2026-10-01/);
  ui.press('Done, 2');
  assert.equal(ui.query('Done step d-new'), undefined);
  assert.ok(ui.get('Now step joined'), 'current plan membership ignores the lagging saved read');
  assert.equal(ui.query('Open lane unplanned'), undefined, 'unplanned lanes start hidden');
  ui.press('1 unplanned lanes');
  assert.ok(ui.get('Open lane unplanned'));
});

test('041-3 rendered: Next to Now writes a new plan version through Save; unplanned lanes add or close', async () => {
  const { ui, log } = await mountTab();
  assert.equal(ui.query('Move x1 to Now in alpha'), undefined, 'reading shows no move controls');
  ui.press('Edit alpha plan');
  ui.press('Move Title x1 in alpha');
  ui.press('Move Title x1 to Now in alpha');
  assert.match(ui.text(), /Unsaved changes/);
  assert.ok(ui.get('Now step x1'));
  assert.equal(ui.query('Next step x1'), undefined);
  ui.press('Save alpha plan');
  const [name, edit] = log.saves[0];
  assert.equal(name, 'alpha');
  assert.equal(edit.version, 4, 'saved against the version it was read at, so a stale save is refused by plan.set');
  assert.equal(edit.entries.find(item => item.lane === 'x1')?.horizon, 'now');
  assert.equal(edit.entries.find(item => item.lane === 'x1')?.doneWhen, 'Then this', 'doneWhen survives a move');
  ui.press('1 unplanned lanes');
  ui.press('Close lane unplanned');
  assert.deepEqual(log.closed, ['unplanned']);
  ui.press('Add unplanned to alpha plan');
  assert.equal(ui.query('1 unplanned lanes'), undefined, 'added lanes leave the unplanned list');
  assert.ok(ui.get('Later step unplanned'), 'and join Later');
});

test('041-4 rendered: a now or next step without doneWhen is marked; later is not', async () => {
  const { ui } = await mountTab();
  assert.ok(ui.get('Done-when not set for n2'));
  assert.equal(ui.query('Done-when not set for n1'), undefined);
  assert.equal(ui.query('Done-when not set for x1'), undefined);
  assert.equal(ui.query('Done-when not set for l1'), undefined);
});

test('041 Drained flag stays hidden until part 2 computes it', async () => {
  const { ui } = await mountTab();
  assert.doesNotMatch(ui.text(), /Drained/);
});

test('an idle plan shows its reason on the roadmap, and an ordinary plan shows none', async () => {
  const idlePlan: ProjectPlan = { ...latest, entries: [entry('l1', 'later')], idle: { reason: 'Waiting for real Cream gaps', at: '2026-10-15T10:00:00.000Z' } };
  const { ui } = await mountTab({ sections: [{ project: projects[0], latest: idlePlan, saved: idlePlan }] });
  assert.ok(ui.get('Idle on purpose: Waiting for real Cream gaps'));
  assert.match(ui.text(), /Idle on purpose since 2026-10-15/);
  const plain = await mountTab();
  assert.equal(plain.ui.query('Idle on purpose: Waiting for real Cream gaps'), undefined);
});

test('Planning renders the current plan while saved membership lags, but waits for the plan itself', async () => {
  const waiting = await mountTab({ sections: [{ project: projects[0] }] });
  assert.match(waiting.ui.text(), /Loading plan…/);
  assert.equal(waiting.ui.query('Now band'), undefined, 'no roadmap is drawn before the current plan arrives');
  assert.equal(waiting.ui.query('1 unplanned lanes'), undefined);
  // Saved membership can lag: current plan entries still drive every roadmap group.
  const stale = await mountTab({ sections: [{ project: projects[0], latest, saved: { ...saved, version: 3 } }] });
  assert.ok(stale.ui.get('Now band'));
  assert.ok(stale.ui.get('Now step joined'));
  assert.equal(stale.ui.query('Open lane unplanned'), undefined, 'an actual unplanned lane remains tucked away');
  // A matching version has the same current roadmap.
  const ready = await mountTab();
  assert.ok(ready.ui.get('Now band'));
  assert.doesNotMatch(ready.ui.text(), /Loading plan…/);
  // A project that never saved a plan has nothing to wait for (version 0).
  const empty = await mountTab({ sections: [{ project: projects[1], latest: { ...latest, project: 'beta', version: 0, entries: [], done: undefined } }] });
  assert.doesNotMatch(empty.ui.text(), /Loading plan…/);
  assert.ok(empty.ui.get('Now band'));
});

/** A draft with its own spies, for states the stateful harness cannot reach (a conflict, a failed save, an idle mark). */
async function mountDraft(sections: PlanSection[], draft: PlanEdit | undefined, over: MountOver = {}) {
  const { PlanningTab } = await import('../client/planning-panel');
  const calls = { edits: [] as Array<[string, PlanEdit]>, saves: [] as Array<[string, PlanEdit]>, cancels: [] as string[] };
  const ui = mount(h(PlanningTab, {
    sections, lanes, edits: draft ? { alpha: draft } : {}, selectedLane: '', step: 'plan', compact: false, busy: false, lanePanel: null,
    onStep: () => {}, onOpenLane: () => {}, onEdit: (p: string, edit: PlanEdit) => calls.edits.push([p, edit]),
    onSave: (p: string, edit: PlanEdit) => calls.saves.push([p, edit]), onCancel: (p: string) => calls.cancels.push(p), c, ...over,
  }));
  return { ui, calls };
}
/** Now n1 and n2, Next x1 and Later l1 at version 4; the draft moves x1 to Now. */
const movedDraft: PlanEdit = { entries: [entry('n1', 'now', 'Ship it'), entry('x1', 'now', 'Then this'), entry('n2', 'now'), entry('l1', 'later')], version: 4 };

test('reading shows no move or save controls at either size; Edit plan opens a draft and Cancel drops it', async () => {
  for (const compact of [false, true]) {
    const { ui } = await mountTab({ compact });
    assert.ok(ui.get('Edit alpha plan'), `Edit plan at compact=${compact}`);
    assert.equal(ui.query('Save alpha plan'), undefined);
    assert.equal(ui.query('Move Title n1 in alpha'), undefined);
    ui.press('Edit alpha plan');
    assert.ok(ui.get('Draft plan for alpha'));
    assert.ok(ui.get('Move Title n1 in alpha'));
    assert.ok(ui.get('Save alpha plan'));
    assert.match(ui.text(), /No changes yet/, 'an unchanged draft says so and cannot be saved');
    assert.equal(ui.get('Save alpha plan').props.disabled, true);
    assert.equal(ui.query('Edit alpha plan'), undefined, 'the draft replaces the Edit plan control');
    ui.press('Cancel alpha plan changes');
    assert.equal(ui.query('Draft plan for alpha'), undefined);
    assert.ok(ui.get('Edit alpha plan'));
  }
});

test('an empty plan says so; unplanned lanes start it in edit mode, and no lanes says so', async () => {
  const empty: ProjectPlan = { project: 'alpha', version: 0, entries: [], author: null, createdAt: null };
  const bare = await mountTab({ sections: [{ project: projects[0], latest: empty, saved: empty }], lanes: [] });
  assert.match(bare.ui.text(), /No plan yet\. No lanes for this project yet\./);
  assert.ok(bare.ui.get('Edit alpha plan'), 'a project with no plan can still start one');
  const withLanes = await mountTab({ sections: [{ project: projects[0], latest: empty, saved: empty }], lanes: [lane('joined')] });
  assert.match(withLanes.ui.text(), /No plan yet\. Edit plan to start one/);
  withLanes.ui.press('1 unplanned lanes');
  assert.ok(withLanes.ui.get('Open lane joined'));
  assert.equal(withLanes.ui.query('Add joined to alpha plan'), undefined, 'adding waits for edit mode');
  withLanes.ui.press('Edit alpha plan');
  withLanes.ui.press('Add joined to alpha plan');
  assert.ok(withLanes.ui.get('Later step joined'));
});

test('a plan that could not be read is an error with a retry, never an empty plan; a refresh failure keeps the last version and says so', async () => {
  let retries = 0;
  const onRetryPlans = () => { retries += 1; };
  const failed = await mountTab({ sections: [{ project: projects[0], error: 'Network down' }], onRetryPlans });
  assert.match(failed.ui.text(), /Couldn’t load this plan: Network down/);
  assert.doesNotMatch(failed.ui.text(), /Loading plan…|No plan yet/);
  failed.ui.press('Retry alpha plan');
  assert.equal(retries, 1);

  const savedFailed = await mountTab({ sections: [{ project: projects[0], error: 'Timed out' }], onRetryPlans });
  assert.match(savedFailed.ui.text(), /Couldn’t load this plan: Timed out/, 'a plan that has not been read is still an error');
  assert.equal(savedFailed.ui.query('Now band'), undefined);

  const stale = await mountTab({ sections: [{ project: projects[0], latest, saved, error: 'Timed out' }], onRetryPlans });
  assert.match(stale.ui.text(), /Showing version 4\. The latest plan could not be refreshed: Timed out\. It may be out of date\./);
  assert.ok(stale.ui.get('Now band'), 'the last version read still reads');
  stale.ui.press('Retry refreshing alpha plan');
  assert.equal(retries, 2);
});

test('a draft based on an older version is kept, cannot be saved, and offers Reapply or Reload', async () => {
  // Someone saved version 5 while the draft sat on version 4: n2 was dropped and joined was added at Later.
  const v5: ProjectPlan = { ...latest, version: 5, entries: [entry('n1', 'now', 'Ship it'), entry('x1', 'next', 'Then this'), entry('l1', 'later'), entry('joined', 'later')] };
  const { ui, calls } = await mountDraft([{ project: projects[0], latest: v5, saved: v5 }], movedDraft);
  assert.ok(ui.get('Plan changed for alpha'));
  assert.match(ui.text(), /The plan changed while you were editing/);
  assert.match(ui.text(), /Version 5 is saved now\. Your draft is based on version 4 and is kept\./);
  assert.ok(ui.get('Draft plan for alpha'), 'the draft is still on screen');
  assert.equal(ui.get('Save alpha plan').props.disabled, true, 'a stale draft is never saved over the newer plan');

  ui.press('Reapply my changes to alpha plan');
  const [, rebased] = calls.edits[0];
  assert.equal(rebased.version, 5, 'reapply moves the draft onto the saved version');
  assert.deepEqual(rebased.entries.map(item => [item.lane, item.horizon]), [['n1', 'now'], ['x1', 'now'], ['l1', 'later'], ['joined', 'later']],
    'the draft keeps its Now choice for x1, drops n2 which the saved plan no longer has, and takes joined from the saved plan');

  ui.press('Reload alpha plan and discard draft');
  assert.deepEqual(calls.cancels, ['alpha']);
});

test('a failed save shows why, keeps the draft, and stays retryable', async () => {
  const { ui, calls } = await mountDraft([{ project: projects[0], latest, saved }], movedDraft, { saveErrors: { alpha: 'Lane n1 is not in this repository' } });
  assert.match(ui.text(), /Not saved: Lane n1 is not in this repository\. Your draft is kept\./);
  assert.ok(ui.get('Draft plan for alpha'));
  assert.equal(ui.get('Save alpha plan').props.disabled, false);
  ui.press('Save alpha plan');
  assert.equal(calls.saves[0][1].version, 4);
});

test('idle is a deliberate mark with a reason, and only when nothing is in Now or Next', async () => {
  const later: PlanEdit = { entries: [entry('n1', 'later'), entry('n2', 'later'), entry('x1', 'later'), entry('l1', 'later')], version: 4 };
  const { ui, calls } = await mountDraft([{ project: projects[0], latest, saved }], later);
  assert.equal(ui.query('Idle options for alpha plan'), undefined, 'idle editor is absent until requested');
  ui.press('Show idle options for alpha plan');
  assert.equal(ui.get('Mark alpha plan idle').props.disabled, true, 'a reason is required');
  ui.type('Idle reason', 'Waiting for Cream gaps');
  ui.press('Mark alpha plan idle');
  assert.equal(calls.edits[0][1].idle, 'Waiting for Cream gaps');
  assert.equal(calls.edits[0][1].entries.length, 4, 'marking idle keeps the order');

  const active = await mountDraft([{ project: projects[0], latest, saved }], movedDraft);
  active.ui.press('Show idle options for alpha plan');
  assert.equal(active.ui.query('Mark alpha plan idle'), undefined, 'no idle while Now or Next has steps');
  assert.match(active.ui.text(), /To go idle, move the 3 Now steps to Later first\./, 'only the counts that apply');
  active.ui.press('Move all alpha steps to Later');
  assert.ok(active.calls.edits[0][1].entries.every(item => item.horizon === 'later'));

  const idleWithNow: PlanEdit = { ...movedDraft, idle: 'Waiting' };
  const blocked = await mountDraft([{ project: projects[0], latest, saved }], idleWithNow);
  blocked.ui.press('Show idle options for alpha plan');
  assert.equal(blocked.ui.get('Save alpha plan').props.disabled, true);
  assert.match(blocked.ui.text(), /An idle plan has no Now or Next steps\. Move them to Later or clear idle\./);
  blocked.ui.press('Remove idle mark from alpha draft');
  assert.equal(blocked.calls.edits[0][1].idle, undefined);
});

test('an idle plan: a changed save ends its mark, End idle saves without one, and only a new reason is sent as idle', async () => {
  const { planSaveInput } = await import('../shared/planning-tab');
  const at = '2026-10-15T10:00:00.000Z';
  const idlePlan: ProjectPlan = { ...latest, entries: [entry('x1', 'later'), entry('l1', 'later')], idle: { reason: 'Waiting', at } };
  const idle = await mountTab({ sections: [{ project: projects[0], latest: idlePlan, saved: idlePlan }] });
  idle.ui.press('Edit alpha plan');
  idle.ui.press('Show idle options for alpha plan');
  assert.match(idle.ui.text(), /Idle on purpose since 2026-10-15: Waiting\. Saving a changed plan or finishing new work ends it\./);
  assert.equal(idle.ui.get('Save alpha plan').props.disabled, true, 'an unchanged draft cannot renew the mark');
  idle.ui.press('Move Title l1 in alpha');
  idle.ui.press('Move Title l1 up');
  assert.equal(idle.ui.get('Save alpha plan').props.disabled, false, 'a reorder is a change');
  idle.ui.press('Save alpha plan');
  const [, changedSave] = idle.log.saves[0];
  assert.equal(changedSave.idle, undefined, 'a draft that leaves the mark alone sends no idle');
  assert.equal('idle' in planSaveInput('alpha', changedSave, 'operator'), false, 'the save ends the mark');

  const ending = await mountTab({ sections: [{ project: projects[0], latest: idlePlan, saved: idlePlan }] });
  ending.ui.press('Edit alpha plan');
  ending.ui.press('Show idle options for alpha plan');
  ending.ui.press('End idle mark on alpha plan');
  assert.equal(ending.ui.get('Save alpha plan').props.disabled, false, 'ending the mark is a change');
  ending.ui.press('Save alpha plan');
  const [, endSave] = ending.log.saves[0];
  assert.equal(endSave.idle, null);
  assert.equal('idle' in planSaveInput('alpha', endSave, 'operator'), false, 'ending sends no idle mark');

  const fresh = await mountTab({ sections: [{ project: projects[0], latest: { ...idlePlan, idle: undefined }, saved: { ...idlePlan, idle: undefined } }] });
  fresh.ui.press('Edit alpha plan');
  fresh.ui.press('Show idle options for alpha plan');
  fresh.ui.type('Idle reason', 'Waiting for Cream gaps');
  fresh.ui.press('Mark alpha plan idle');
  assert.equal(fresh.log.saves.length, 0, 'marking idle is a draft change, not a save');
  assert.equal(fresh.ui.get('Save alpha plan').props.disabled, false);
  fresh.ui.press('Save alpha plan');
  const [, markSave] = fresh.log.saves[0];
  assert.equal(planSaveInput('alpha', markSave, 'operator').idle, 'Waiting for Cream gaps', 'a new mark is sent');
});

test('a read plan that is idle says so and says what ends it', async () => {
  const idlePlan: ProjectPlan = { ...latest, entries: [entry('l1', 'later')], idle: { reason: 'Waiting', at: '2026-10-15T10:00:00.000Z' } };
  const { ui } = await mountTab({ sections: [{ project: projects[0], latest: idlePlan, saved: idlePlan }] });
  assert.match(ui.text(), /Idle on purpose since 2026-10-15: Waiting\. Saving a changed plan or finishing new work ends it\./);
});
