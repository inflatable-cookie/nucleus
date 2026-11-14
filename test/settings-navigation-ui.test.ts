import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, waitFor } from './support/budgets';

useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, {get: () => '#123'}) as never;
// Query notifications use timers; a turn count can expire before their timer runs.
const settle = (probe: () => boolean) => waitFor(probe, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'screen to settle');
const board = {revision:1, connected:true, hostId:'host', paused:false, error:'', quiet:true, activeWorkers:0, unsettled:0, globalLimit:32, projectLimit:5, papercutProjectLimit:2, tasks:[], profiles:[], pool:[], availability:[], assignments:{}, recentAssignments:{}, lanes:[], projects:[], projectLimitOverrides:{}, projectInFlightLimitOverrides:{}, projectCapacities:[], prStates:{}, usage:{level:'normal',setLevel:'normal',until:null,expired:false}, demandOffsets:{worker:0,reviewer:0,coordinator:0}, routingGrants:[], backup:{newestSnapshotAt:'2026-11-07T21:00:00Z',localError:null}};
const capacity = {effective:{globalLimit:32,projectLimit:5,papercutProjectLimit:2,paseoCallLimit:6,stallThresholdMinutes:30,holdReminderMinutes:120,holdEscalationMinutes:240,laneDrainMinutes:120,laneDrainEscalationMinutes:1440,hostOutageNoticeMinutes:120},changes:[]};

async function screen(width: number, invoke: (method:string) => Promise<unknown>, layoutCompact = false) {
  const { QueueSettingsScreen } = await import('../client/settings-screen');
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const ui = mount(h(QueryClientProvider, {client, children:h(PluginRpcProvider, {invoke: invoke as never, children:h(QueueSettingsScreen as never, {theme:{colors}, layout:{compact:layoutCompact, platform:'ios'}, host:{id:'host',label:'Host'}})})}));
  ui.get('Nucleus settings').props.onLayout({ nativeEvent: { layout: { width } } });
  return ui;
}
const missing = async () => [];
const invokeBoard = async (method: string) => method === 'queue.ui-snapshot' ? board : method === 'queue.capacity-state' ? capacity : method === 'queue.telemetry' ? new Promise(() => {}) : missing();

type Node = { type: string; props: Record<string, any>; children: Array<Node | string> };
const tabsOf = (ui: Awaited<ReturnType<typeof screen>>) => (ui.get('Settings sections') as Node).children.filter((node): node is Node => typeof node !== 'string');
const SECTIONS = ['Dispatch limits', 'Profiles', 'Projects', 'Backups', 'Telemetry'];

test('one row of five tabs at every width, the same at a narrow host, the Paseo settings column and a wide page', async () => {
  // nucleus#963: no dropdown and no rail; the host's compact flag changes nothing.
  for (const [width, compact] of [[390, true], [640, true], [688, true], [1024, false], [900, true]] as const) {
    const ui = await screen(width, invokeBoard, compact);
    await settle(() => ui.text().includes('Usage level'));
    const row = ui.get('Settings sections') as Node;
    assert.equal(row.type, 'View', `${width}: a plain row, no scroller`);
    assert.equal(row.props.style.flexDirection, 'row');
    assert.equal(row.props.style.flexWrap, 'nowrap', `${width}: the tabs never wrap`);
    assert.notEqual(row.props.horizontal, true, `${width}: no horizontal scroll`);
    assert.deepEqual(tabsOf(ui).map(tab => tab.props.accessibilityLabel), SECTIONS, `${width}: every section is a tab`);
    assert.equal(ui.query('Settings section, Dispatch limits'), undefined, `${width}: no section dropdown`);
    assert.equal(ui.get('Dispatch limits').props.accessibilityState.selected, true, `${width}: Limits opens first`);
    assert.equal(ui.ofType('Modal').length, 0, `${width}: no dialog for section navigation`);
    ui.update(h('View'));
  }
});

test('the tabs show the short labels and keep the full names for a screen reader', async () => {
  const ui = await screen(688, invokeBoard, true);
  await settle(() => ui.text().includes('Usage level'));
  const shown = tabsOf(ui).map(tab => (function text(node: Node | string): string { return typeof node === 'string' ? node : node.children.map(text).join(''); })(tab));
  assert.deepEqual(shown, ['Limits', 'Profiles', 'Projects', 'Backups', 'Telemetry']);
  assert.equal(tabsOf(ui).some(tab => tab.props.accessibilityLabel === 'Subscriptions'), false, 'no Subscriptions tab');
  ui.update(h('View'));
});

test('each tab opens its section and stays ticked; the content takes the full width', async () => {
  const ui = await screen(1024, invokeBoard);
  await settle(() => ui.text().includes('Usage level'));
  for (const section of ['Profiles', 'Telemetry', 'Backups', 'Dispatch limits'] as const) {
    ui.press(section);
    if (section === 'Profiles') await settle(() => ui.text().includes('No profiles yet'));
    if (section === 'Telemetry') await settle(() => ui.text().includes('Loading telemetry') || ui.text().includes('Could not load telemetry'));
    if (section === 'Backups') assert.ok(ui.get('Store backups'));
    if (section === 'Dispatch limits') await settle(() => ui.text().includes('Usage level'));
    for (const tab of tabsOf(ui)) assert.equal(tab.props.accessibilityState.selected, tab.props.accessibilityLabel === section, `${section}: only its tab is ticked`);
  }
  // No rail beside the content: the screen's children stack in one column.
  assert.equal(ui.ofType('ScrollView').some(node => node.props.style?.width === 190), false, 'no section rail');
  ui.update(h('View'));
});

test('Profiles holds the Subscriptions list beneath the profiles, with its empty and loading states', async () => {
  const ui = await screen(688, invokeBoard, true);
  await settle(() => ui.text().includes('Usage level'));
  ui.press('Profiles');
  await settle(() => ui.text().includes('No profiles yet'));
  const page = ui.get('Profiles page') as Node;
  const sections = page.children.filter((node): node is Node => typeof node !== 'string');
  const labels = (function labelsOf(nodes: Node[]): string[] { return nodes.flatMap(node => [node.props.accessibilityLabel, ...labelsOf(node.children.filter((child): child is Node => typeof child !== 'string'))]).filter(label => label === 'Stored profiles' || label === 'Subscriptions'); })(sections);
  assert.deepEqual(labels, ['Stored profiles', 'Subscriptions'], 'Subscriptions sit under the profile list');
  assert.match(ui.text(), /None yet\. Add a profile first\./);
  ui.update(h('View'));

  let release!: (value: unknown) => void;
  const slow = new Promise(resolve => { release = resolve; });
  const loading = await screen(688, async method => method === 'queue.ui-snapshot' ? slow : method === 'queue.capacity-state' ? capacity : missing());
  loading.press('Profiles');
  await settle(() => loading.text().includes('Reading subscriptions…'));
  release(board);
  await settle(() => loading.text().includes('None yet. Add a profile first.'));
  loading.update(h('View'));
});

test('long subscription group names stay in their row with accessible controls', async () => {
  const group = 'a-very-long-subscription-group-name-that-would-overrun-a-narrow-settings-column';
  const state = { ...board, profiles: [{ id: 'p', name: 'P', provider: 'openai', model: 'gpt-5', notes: '', available: true, problem: '', supportedThinking: [] }], pool: [{ profileId: 'p', group, enabled: true, scopes: ['general'], weight: 1 }],
    availability: [{ group, unavailable: true, reason: 'weekly limit', retryAt: null }] };
  const ui = await screen(390, async method => method === 'queue.ui-snapshot' ? state : method === 'queue.capacity-state' ? capacity : missing(), true);
  await settle(() => ui.text().includes('Usage level'));
  ui.press('Profiles');
  await settle(() => Boolean(ui.query(`Edit ${group}`)));
  assert.ok(ui.get(`Reset ${group}`));
  const name = ui.ofType('Text').find(node => node.children.join('') === group)!;
  assert.equal(name.props.style.flex, 1, 'the name takes the free space and wraps inside the row');
  ui.update(h('View'));
});

test('projects distinguish loading, failure and empty results', async () => {
  let rejectProjects!: (e: Error) => void;
  const pending = new Promise((_resolve, reject) => {rejectProjects = reject;});
  const ui = await screen(1024, async method => {
    if (method === 'queue.ui-snapshot') return board;
    if (method === 'queue.capacity-state') return capacity;
    if (method === 'project.settings') return pending;
    return [];
  });
  await settle(() => ui.text().includes('Usage level'));
  assert.equal(ui.query('Repositories'), undefined, 'Projects replaced Repositories');
  ui.press('Projects');
  await settle(() => ui.text().includes('Loading projects'));
  rejectProjects(new Error('offline'));
  await settle(() => ui.text().includes("Couldn't load projects"));
  assert.ok(ui.get('Retry projects'));
  ui.update(h('View'));
});

test('telemetry distinguishes loading, failed, stale and empty reads and keeps long filter values accessible', async () => {
  const { SettingsTelemetry } = await import('../client/settings-telemetry');
  const { telemetrySnapshotSchema } = await import('../shared/telemetry');
  const longRepoName = `project-${'long-name-'.repeat(30)}`;
  const empty = {filters:{window:'24h',groupBy:'none'}, matchingTasks:0, generatedAt:'2026-11-07T00:00:00Z', repositories:[`/repos/${longRepoName}`], scopes:[], profileGroups:[], interventionProviders:[], reviewerProviders:[], reviewerProfiles:[], reviewerProfileGroups:[], groups:[], omittedGroups:0, truncatedDimensions:[], controls:{owner:{applied:0,refused:0,refusalRate:null},coordinator:{applied:0,refused:0,refusalRate:null},windowDays:30,byAction:[],topRefusals:[]}};
  const distribution = {count:1,partialCount:0,p50Ms:1200,p95Ms:1200};
  const populated = telemetrySnapshotSchema.parse({...empty,matchingTasks:1,groups:[{
    key:'all',label:'All tasks',taskCount:1,completedCount:1,completionRate:1,interventionTaskCount:0,interventionRate:0,
    total:distribution,waiting:distribution,active:distribution,stages:[],
    interventions:{recoveryRuns:0,recoveries:[],uncertainCreations:0,absentCreations:0,attentionNotices:0,escalations:0,hookHolds:0,hookRetries:0,revisions:0,replacements:0,operatorActions:[]},
    closeoutAuthorities:{repositoryHook:0,agent:1,pending:0,none:0},evidence:'exact',
  }]});
  for (const outcome of ['loading','error','stale','empty','populated'] as const) {
    for (const compact of outcome === 'empty' || outcome === 'populated' ? [true, false] : [true]) {
      const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
      let reads = 0;
      const invoke = async () => {
        reads++;
        if (outcome === 'loading') return new Promise(() => {});
        if (outcome === 'error' || outcome === 'stale' && reads > 1) throw new Error('offline');
        return outcome === 'populated' ? populated : empty;
      };
      const ui = mount(h(QueryClientProvider, {client,children:h(PluginRpcProvider, {invoke:invoke as never,children:h(SettingsTelemetry, {c:colors,compact})})}));
      if (outcome === 'loading') assert.match(ui.text(), /Loading telemetry/);
      if (outcome === 'error') { await settle(() => ui.text().includes('Could not load telemetry')); assert.ok(ui.get('Retry loading telemetry')); }
      if (outcome === 'stale') { await settle(() => ui.text().includes('0 matching tasks')); await client.refetchQueries({queryKey:['nucleus','telemetry']}); await settle(() => ui.text().includes('Telemetry refresh failed; showing the last result')); assert.match(ui.text(), /No task activity matches/); }
      if (outcome === 'empty') { await settle(() => ui.text().includes('No task activity matches')); assert.match(ui.text(), /0 matching tasks/); assert.ok(ui.get('Task control history and refusal reasons')); assert.ok(ui.get('Project filter, All projects')); ui.press('Project filter, All projects'); assert.match(ui.text(), new RegExp(longRepoName)); ui.press(`Project: ${longRepoName}`); await settle(() => ui.text().includes('0 matching tasks')); ui.press('More filters'); assert.ok(ui.get('Cohort created after')); ui.type('Cohort created after','bad date'); assert.match(ui.text(), /Enter a valid date/); }
      if (outcome === 'populated') { await settle(() => ui.text().includes('1 matching tasks')); assert.match(ui.text(), /Finished[\s\S]*100%/); assert.match(ui.text(), /Needed help[\s\S]*0%/); assert.doesNotMatch(ui.text(), /Exact transition evidence/); ui.press('Technical detail'); assert.match(ui.text(), /Exact transition evidence/); }
      ui.update(h('View'));
    }
  }
});
