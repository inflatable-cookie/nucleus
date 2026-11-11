import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardSource } from './support/board-source';
import {
  defaultProjectScope, effectiveSelection, pipelineSelection, planningScopeLanes, projectSelectorRows, readProjectScope, scopeContains, scopedProjects,
  selectionLabel, statusSelection, toggleProject, writeProjectScope,
} from '../shared/project-scope';
import type { Project } from '../shared/contracts';

const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (key: string, name: string, ...repos: ReturnType<typeof repo>[]): Project => ({ key, name, version: 1, visibility: 'active', repositories: repos, primary: repos[0], drain: null });
const consumer = project('consumer-b-v2', 'consumer-b-v2', repo('consumer'), repo('consumer-web'));
const projectA = project('project-a-accelerator', 'project-a-accelerator', repo('project-a'));
const other = project('other', 'Other', repo('other'));
const projects = [other, projectA, consumer];

test('026-14b two selected projects scope every view to both; none means all', () => {
  const both = ['consumer-b-v2', 'project-a-accelerator'];
  const contains = scopeContains(projects, both);
  assert.equal(contains('/consumer-web', 'owner/consumer-web'), true, 'a second repository of a selected project is in scope');
  assert.equal(contains('/project-a', null), true);
  assert.equal(contains('/other', 'owner/other'), false);
  assert.deepEqual(scopedProjects(projects, both).map(item => item.key), ['consumer-b-v2', 'project-a-accelerator'], 'Planning shows both plans');
  const all = scopeContains(projects, []);
  assert.equal(all('/other', 'owner/other'), true);
  assert.deepEqual(scopedProjects(projects, []).map(item => item.key), ['consumer-b-v2', 'other', 'project-a-accelerator']);
  assert.equal(selectionLabel(projects, []), 'All projects');
  assert.equal(selectionLabel(projects, ['other']), 'Other');
  assert.equal(selectionLabel(projects, both), '2 projects');
});

test('Spec 027 #11 selector Parked section and All projects view hide parked while a selected parked project remains reachable', () => {
  const parked = { ...projectA, visibility: 'parked' as const, version: 2 };
  const all = [other, parked, consumer];
  assert.deepEqual(projectSelectorRows(all, [], '', [], []).map(row => [row.key, row.visibility]), [
    ['consumer-b-v2', 'active'], ['other', 'active'], ['project-a-accelerator', 'parked'],
  ]);
  assert.deepEqual(scopedProjects(all, []).map(project => project.key), ['consumer-b-v2', 'other']);
  assert.equal(scopeContains(all, [])('/project-a', 'owner/project-a'), false);
  assert.equal(scopeContains(all, ['project-a-accelerator'])('/project-a', 'owner/project-a'), true);
  assert.deepEqual(scopedProjects(all, ['project-a-accelerator']).map(project => project.key), ['project-a-accelerator']);
});

test('026-14b a stale selected key is ignored rather than hiding everything', () => {
  assert.deepEqual(effectiveSelection(projects, ['gone']), []);
  assert.equal(scopeContains(projects, ['gone'])('/other', 'owner/other'), true);
  assert.deepEqual(effectiveSelection([], ['gone']), ['gone'], 'kept until projects load');
});

test('026-14b the Pipeline filter switch off shows all projects and on restores the kept selection', () => {
  const scope = { projects: ['consumer-b-v2', 'project-a-accelerator'], statusFilter: true };
  assert.deepEqual(pipelineSelection(scope), scope.projects);
  const off = { ...scope, statusFilter: false };
  assert.deepEqual(pipelineSelection(off), []);
  assert.deepEqual(off.projects, scope.projects, 'switching off keeps the selection');
  assert.deepEqual(pipelineSelection({ ...off, statusFilter: true }), scope.projects);
  assert.equal(statusSelection, pipelineSelection, 'the pre-retirement alias still resolves');
});

test('026-14b the selector lists every project with filter, primary repository, counts and checkboxes', () => {
  const tasks = [{ repository: 'owner/consumer-web', repoPath: '/consumer-web', phase: 'working' }, { repository: 'owner/consumer', repoPath: '/consumer', phase: 'done' }] as Parameters<typeof projectSelectorRows>[3];
  const leads = [{ id: 'l1', title: 'L1', state: 'open', lanes: [], repositories: [repo('project-a')] }] as Parameters<typeof projectSelectorRows>[4];
  const rows = projectSelectorRows(projects, ['project-a-accelerator'], '', tasks, leads);
  assert.deepEqual(rows.map(row => [row.key, row.primary, row.tasks, row.leads, row.checked]), [
    ['consumer-b-v2', 'owner/consumer', 1, 0, false],
    ['other', 'owner/other', 0, 0, false],
    ['project-a-accelerator', 'owner/project-a', 0, 1, true],
  ]);
  assert.deepEqual(projectSelectorRows(projects, [], 'PROJECT-A', tasks, leads).map(row => row.key), ['project-a-accelerator']);
  assert.deepEqual(toggleProject(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleProject(['a', 'b'], 'a'), ['b']);
});

test('026-14b the selection and Pipeline filter switch persist in local storage, else for the session', () => {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) };
  const scope = { projects: ['consumer-b-v2', 'project-a-accelerator'], statusFilter: false };
  writeProjectScope(storage, scope);
  assert.deepEqual(readProjectScope(storage), scope);
  assert.deepEqual(readProjectScope(undefined), scope, 'no storage keeps the session copy');
  items.set('northstar-queue:project-scope', '{broken');
  assert.deepEqual(readProjectScope(storage), scope);
  writeProjectScope(undefined, defaultProjectScope);
  assert.deepEqual(readProjectScope(undefined), defaultProjectScope);
});

test('026-14b project scope migrates the old local key once and uses the Nucleus key after', () => {
  const items = new Map<string, string>([['northstar-queue:project-scope', JSON.stringify({ projects: ['project-a-accelerator'], statusFilter: false })]]);
  const reads = new Map<string, number>();
  const storage = {
    getItem: (key: string) => { reads.set(key, (reads.get(key) ?? 0) + 1); return items.get(key) ?? null; },
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  assert.deepEqual(readProjectScope(storage), { projects: ['project-a-accelerator'], statusFilter: false });
  assert.equal(items.has('northstar-queue:project-scope'), false);
  assert.deepEqual(JSON.parse(items.get('nucleus:project-scope')!), { projects: ['project-a-accelerator'], statusFilter: false });
  assert.deepEqual(readProjectScope(storage), { projects: ['project-a-accelerator'], statusFilter: false });
  assert.equal(reads.get('northstar-queue:project-scope'), 1);
});

test('026-14a Planning lanes in scope: selected plans plus lanes listing a selected repository', () => {
  const plans = [{ project: 'consumer-b-v2', version: 1, entries: [{ lane: 'consumer-plan', note: '', horizon: 'now' }] }, { project: 'other', version: 1, entries: [{ lane: 'other-plan', note: '', horizon: 'now' }] }] as Parameters<typeof planningScopeLanes>[2];
  const lanes = [{ key: 'project-a-lane', repositories: [repo('project-a')] }, { key: 'other-lane', repositories: [repo('other')] }];
  assert.deepEqual(planningScopeLanes(projects, ['consumer-b-v2', 'project-a-accelerator'], plans, lanes), ['consumer-plan', 'project-a-lane']);
  assert.deepEqual(planningScopeLanes(projects, [], plans, lanes), ['consumer-plan', 'other-plan', 'project-a-lane', 'other-lane']);
});

test('026-14b one header selector scopes every view; its Enabled switch turns filtering off everywhere', () => {
  const ui = boardSource();
  const controls = readFileSync(new URL('../client/project-scope-controls.tsx', import.meta.url), 'utf8');
  // Cutover 7 (PR 850) reformatted the board and routed papercut/lead cards
  // through the shared BoardCard; the selector stays one instance in the header
  // guard across the four views.
  assert.equal(ui.match(/<ProjectSelector\b/g)?.length, 1, 'one selector in the header');
  assert.match(ui, /\(tab === "queue" \|\|\s*tab === "planning" \|\|\s*tab === "qa"\) && \(\s*<ProjectSelector/);
  assert.match(ui, /const selection = effectiveSelection\(state\?\.projects \?\? \[\], activeSelection\(scope\)\)/, 'stale keys drop out for every view');
  assert.match(ui, /const selection = effectiveSelection\(state\?\.projects \?\? \[\], activeSelection\(scope\)\);/, 'the Enabled switch scopes every view');
  assert.match(ui, /const pipelineFilterSelection = selection;/);
  assert.match(ui, /const pipelineInput = \{[^}]*selection:pipelineFilterSelection,/, 'Pipeline input carries the filtered selection');
  assert.match(ui, /pipelineBoard\(pipelineInput\)/, 'Pipeline');
  assert.match(ui, /lanes=\{state\?\.lanes \?\? \[\]\}/, 'Planning receives the lanes the finder searches');
  assert.match(ui, /selection=\{activeSelection\(scope\)\}/, 'the Planning chooser writes the one project scope');
  assert.match(ui, /card\.value\.tags\.includes\("papercut"\)/, 'Pipeline Triage routes papercut-tagged leads to their detail modal');
  assert.match(ui, /const planningProjects = effectiveSelection/, 'Planning');
  assert.match(ui, /planningLaneLeads\(boardLeads, planningLane, state\?\.projects\?\?\[\],/, 'Planning lane leads');
  assert.match(ui, /usePlanningLane\(planningInScope,/);
  assert.match(ui, /<ProjectSelector\s+enabled=\{scope\.statusFilter\}\s+onEnabledChange=\{\(statusFilter\) =>\s*setScope\(\{ \.\.\.scope, statusFilter \}\)\s*\}\s*projects=/, 'the switch lives in the selector and keeps the selection');
  assert.doesNotMatch(ui, /<ProjectFilterSwitch/, 'no separate switch on the board');
  assert.match(controls, /writeProjectScope\(storage\(\), scope\)/);
  assert.doesNotMatch(ui, /projectFilter/);
});
