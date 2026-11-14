import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { formatLocalDateTime } from '../shared/date-time';
import type { CapacityAuthorityValues, CapacityChange } from '../shared/contracts';

useNativeStubs();
const h = React.createElement;
const limits = () => import('../client/limits');

const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149', statusSuccess: '#3fb950' } as const;
const c = dark as never;

const CAPACITY: CapacityAuthorityValues = { globalLimit: 32, projectLimit: 5, papercutProjectLimit: 2, paseoCallLimit: 6, stallThresholdMinutes: 30, holdReminderMinutes: 120, holdEscalationMinutes: 240, laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440, hostOutageNoticeMinutes: 120 };
/** A recorded change that moved the named limits, each as [before, after]. */
const change = (version: number, moves: Partial<Record<keyof CapacityAuthorityValues, [number, number]>>, at: string): CapacityChange => ({
  version, at, surface: 'paseo',
  before: { ...CAPACITY, ...Object.fromEntries(Object.entries(moves).map(([key, [from]]) => [key, from])) } as CapacityAuthorityValues,
  after: { ...CAPACITY, ...Object.fromEntries(Object.entries(moves).map(([key, [, to]]) => [key, to])) } as CapacityAuthorityValues,
});
const authority = (overrides: { effective?: Partial<CapacityAuthorityValues>; changes?: CapacityChange[] } = {}) => ({
  effective: { ...CAPACITY, ...overrides.effective }, changes: overrides.changes ?? [],
});
const state = (overrides: Record<string, unknown> = {}) => ({
  usage: { level: 'normal', setLevel: 'normal', until: null, expired: false },
  routingGrants: [], profiles: [], projects: [], projectLimit: 5, projectLimitOverrides: {}, projectCapacities: [],
  demandOffsets: { worker: 0, reviewer: 0, coordinator: -2 }, ...overrides,
}) as never;
const noop = async () => undefined;

/** The Limits panel with the given reads. Writes and refreshes are inert: these tests read the screen. */
async function mountLimits(overrides: Record<string, unknown> = {}) {
  const { DispatchLimits } = await limits();
  const calls = { retry: 0 };
  const props = {
    c, state: state(), busy: false, authority: authority(), authorityError: null,
    retryAuthority: () => { calls.retry++; }, refreshBoard: noop, saveUsage: noop, saveDemandOffsets: noop, saveCapacity: noop, saveProjectLimit: noop,
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: async () => ({}), children: h(DispatchLimits as never, props as never) }) }));
  return { ui, calls, done: () => { ui.update(h('View', null)); client.clear(); } };
}

test('limits show applied values beside controls, and the recorded changes stay off the screen', async () => {
  const applied = { globalLimit: 21, stallThresholdMinutes: 45 };
  const v1 = '2026-11-02T09:00:00.000Z', v2 = '2026-11-03T10:30:00.000Z';
  const { ui, done } = await mountLimits({ authority: authority({ effective: applied, changes: [
    change(1, { globalLimit: [32, 21] }, v1), change(2, { stallThresholdMinutes: [30, 45] }, v2),
  ] }) });
  try {
    assert.equal(ui.get('Global dispatch limit (slots, 1–64)').props.value, '21');
    assert.doesNotMatch(ui.text(), /In force/, 'the value in force shows only when the entered value differs');
    assert.doesNotMatch(ui.text(), /Last saved/);
    ui.press('Advanced limits');
    assert.equal(ui.get('Stall threshold dispatch limit (minutes, 1–240)').props.value, '45');
    // The change log stays for the CLI through queue.capacity-state; Settings shows no view of it (Tom, 2026-11-08).
    assert.doesNotMatch(ui.text(), /Recorded changes|Change history|Version 2 ·|Global 32 → 21/);
    assert.doesNotMatch(ui.text(), new RegExp(escape(formatLocalDateTime(v2))));
    assert.equal(ui.query('View change history'), undefined);
    assert.equal(ui.query('Dispatch limit change history'), undefined);
  } finally { done(); }
});

test('a full record adds nothing to the screen: Frontier grants is the last section', async () => {
  const twenty = Array.from({ length: 20 }, (_, index) => change(index + 1, { holdReminderMinutes: [120, 120 + index] }, `2026-11-01T0${index % 9}:00:00.000Z`));
  const { ui, done } = await mountLimits({ authority: authority({ changes: twenty }) });
  try {
    assert.equal(ui.get('Global dispatch limit (slots, 1–64)').props.value, '32');
    assert.doesNotMatch(ui.text(), /Recorded changes|of 20 kept/);
    const titles = ui.ofType('Text').map(node => node.children.join('')).filter(text => ['Usage level', 'Task slots', 'Project overrides', 'Role demand', 'Frontier grants'].includes(text));
    assert.deepEqual(titles, ['Usage level', 'Task slots', 'Project overrides', 'Role demand', 'Frontier grants']);
  } finally { done(); }
});

test('a project override is one row: the name, the bare slots control and one remove icon', async () => {
  const projectA = { key: 'project-a', name: 'Project-A' };
  const { ui, done } = await mountLimits({
    state: state({
      projects: [projectA], projectLimitOverrides: { 'project-a': 3 },
      projectCapacities: [{ projectKey: 'project-a', projectName: 'Project-A', occupiedSlots: 1, slotLimit: 3, inFlightTasks: 0, inFlightLimit: 6 }],
    }),
  });
  try {
    assert.equal(ui.get('Task slots for Project-A (0–64; 0 admits nothing)').props.value, '3', 'the effective slot limit');
    assert.equal(ui.query(/In-flight task cap/), undefined, 'the in-flight cap is always twice the slots, so it has no control');
    assert.equal(ui.query('Project-A actions'), undefined, 'no ⋯ menu for a single action');
    const remove = ui.get('Remove the Project-A override');
    assert.equal(remove.props.accessibilityHint, 'Remove the Project-A override', 'the icon button names its action and its object');
    assert.doesNotMatch(ui.text(), /Slots|In flight/, 'the only input needs no label');
    ui.press('Remove the Project-A override');
    assert.match(ui.text(), /Remove this override\?/, 'removing asks first, inside the row');
    ui.press('Keep Project-A dispatch limit override');
    assert.doesNotMatch(ui.text(), /Remove this override\?/);
  } finally { done(); }
});

test('the value in force appears under a limit only once the entered value differs from it', async () => {
  const { ui, done } = await mountLimits();
  try {
    assert.doesNotMatch(ui.text(), /In force/);
    ui.get('Global dispatch limit (slots, 1–64)').props.onFocus();
    ui.get('Global dispatch limit (slots, 1–64)').props.onChangeText('40');
    await settle(() => /In force 32 slots/.test(ui.text()));
    assert.equal(ui.get('Global dispatch limit (slots, 1–64)').props.value, '40');
  } finally { done(); }
});

test('loading, a failed first read and a failed refresh each say what is and is not shown, and Try again re-reads', async () => {
  const loading = await mountLimits({ authority: undefined });
  try {
    assert.match(loading.ui.text(), /Reading the dispatch limits…/);
    assert.equal(loading.ui.query('Global dispatch limit (slots, 1–64)'), undefined, 'no field is shown as applied while reading');
    assert.doesNotMatch(loading.ui.text(), /Recorded changes/);
    assert.equal(loading.ui.query('Retry reading the dispatch limits'), undefined, 'nothing to retry while the first read is in flight');
  } finally { loading.done(); }

  const failed = await mountLimits({ authority: undefined, authorityError: new Error('capacity store offline') });
  try {
    assert.match(failed.ui.text(), /Couldn't read the dispatch limits, so none is shown as applied\. Nothing was changed\./);
    assert.match(failed.ui.text(), /capacity store offline/);
    assert.equal(failed.ui.query('Global dispatch limit (slots, 1–64)'), undefined);
    assert.equal(failed.ui.get('Retry reading the dispatch limits').props.accessibilityRole, 'button');
    failed.ui.press('Retry reading the dispatch limits');
    assert.equal(failed.calls.retry, 1, 'a failed read is safe to retry: nothing was written');
  } finally { failed.done(); }

  const stale = await mountLimits({ authorityError: new Error('timeout') });
  try {
    assert.match(stale.ui.text(), /Couldn't refresh the dispatch limits\. The values shown may be out of date; nothing was changed\./);
    assert.equal(stale.ui.get('Global dispatch limit (slots, 1–64)').props.value, '32', 'the last values read stay on screen, marked stale');
    stale.ui.press('Retry reading the dispatch limits');
    assert.equal(stale.calls.retry, 1);
  } finally { stale.done(); }
});

test('empty states name what is absent and the next meaningful action', async () => {
  const { ui, done } = await mountLimits();
  try {
    assert.doesNotMatch(ui.text(), /None yet\. The first change made here is recorded\./, 'no empty change log');
    assert.match(ui.text(), /None\. Every project uses the per-project limit\./);
    assert.match(ui.text(), /None\. A planner asks once, and the request arrives on the board\./);
  } finally { done(); }
});

test('Advanced limits stays folded until opened, and its six limits keep their accessible names and units', async () => {
  const { ui, done } = await mountLimits();
  try {
    assert.equal(ui.get('Advanced limits').props.accessibilityState.expanded, false);
    assert.equal(ui.query('Paseo calls dispatch limit (calls, 1–32)'), undefined, 'folded: the timing fields are not on the page');
    ui.press('Advanced limits');
    assert.equal(ui.get('Advanced limits').props.accessibilityState.expanded, true);
    assert.equal(ui.get('Paseo calls dispatch limit (calls, 1–32)').props.value, '6');
    assert.equal(ui.get('Stall threshold dispatch limit (minutes, 1–240)').props.value, '30', 'an advanced field keeps its value');
  } finally { done(); }
});

test('long names and reasons wrap instead of running past their row', async () => {
  const longName = 'Project-A Integration Workspace For Long Project Names On A Narrow Board';
  const { ui, done } = await mountLimits({
    state: state({ projects: [{ key: 'project-a', name: longName }], projectLimitOverrides: { 'project-a': 3 } }),
  });
  try {
    const name = ui.ofType('Text').find(node => node.children.join('') === longName);
    assert.ok(name, 'the project name renders in full');
    assert.equal(name.props.style.flexShrink, 1, 'the name wraps inside its row');
    assert.equal(name.props.numberOfLines, undefined, 'the name is never truncated');
    const status = ui.get(`Task slots for ${longName} (0–64; 0 admits nothing)`);
    assert.ok(status, 'the long-named field keeps its accessible name');
  } finally { done(); }
});

test('the number control steps inside its bounds, and typing reaches the same owner, clamped', async () => {
  const { NumberStepper } = await import('../client/controls');
  const label = 'Global dispatch limit (slots, 1–64)';
  const values: number[] = [];
  const ui = mount(h(NumberStepper as never, { c, a11yLabel: label, value: 24, min: 1, max: 64, onChange: (value: number) => values.push(value) }));
  ui.press(`Increase ${label}`);
  ui.press(`Decrease ${label}`);
  const field = () => ui.get(label);
  field().props.onFocus();
  field().props.onChangeText('3a0');
  assert.equal(field().props.value, '30', 'digits only');
  field().props.onChangeText('90');
  field().props.onBlur();
  assert.deepEqual(values, [25, 23, 30, 64], 'each step and each typed value goes to the owner; out of range clamps when typing ends');
  const keys = mount(h(NumberStepper as never, { c, a11yLabel: label, value: 10, min: 1, max: 64, onChange: (value: number) => values.push(value) }));
  keys.get(label).props.onFocus();
  keys.get(label).props.onKeyPress({ nativeEvent: { key: 'ArrowUp' } });
  keys.get(label).props.onKeyPress({ nativeEvent: { key: 'ArrowDown' } });
  assert.deepEqual(values.slice(-2), [11, 9], 'arrow keys step while focused');
  const top = mount(h(NumberStepper as never, { c, a11yLabel: label, value: 64, min: 1, max: 64, onChange: noop }));
  assert.equal(top.get(`Increase ${label}`).props.accessibilityState.disabled, true, 'Increase stops at the bound');
  assert.equal(top.get(label).props.keyboardType, 'number-pad');
});

test('the number control looks like a bold number: no box, Role demand width, optional label and card', async () => {
  const { NumberStepper } = await import('../client/controls');
  const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0';
  const values: number[] = [];
  const card = mount(h(NumberStepper as never, { c, card: true, label: 'Coordinator', a11yLabel: 'coordinator demand offset', value: -2, min: -4, max: 4, format: signed, onChange: (value: number) => values.push(value) }));
  const input = card.get('coordinator demand offset');
  assert.equal(input.props.value, '−2', 'at rest the number reads in its own format');
  assert.equal(input.props.style.borderWidth, 0, 'no visible box');
  assert.equal(input.props.style.width, 24, 'as wide as Role demand\'s number');
  assert.equal(input.props.style.fontWeight, '600');
  assert.match(card.text(), /Coordinator/, 'the label shows');
  assert.ok(card.ofType('View').some(node => node.props.style?.borderRadius !== undefined && node.props.style?.flexBasis === 200), 'the card wraps it');
  input.props.onFocus();
  assert.equal(card.get('coordinator demand offset').props.value, '-2', 'focus edits the plain number');
  card.get('coordinator demand offset').props.onChangeText('-3');
  assert.deepEqual(values, [-3], 'a leading minus is kept where the range allows');
  const bare = mount(h(NumberStepper as never, { c, a11yLabel: 'Task slots for Project-A', value: 3, min: 0, max: 64, onChange: noop }));
  assert.deepEqual(bare.ofType('Text').map(node => node.children.join('')), ['−', '+'], 'the bare control has no label');
  assert.ok(!bare.ofType('View').some(node => node.props.style?.flexBasis === 200), 'and no card');
  bare.get('Task slots for Project-A').props.onFocus();
  bare.get('Task slots for Project-A').props.onChangeText('-5');
  assert.equal(bare.get('Task slots for Project-A').props.value, '5', 'no minus when the range starts at zero');
});

test('the task slots sit on one wrapping row of steppers at narrow and wide sizes', async () => {
  const { ui, done } = await mountLimits();
  try {
    assert.equal(ui.ofType('TextInput').filter(node => /dispatch limit \(/.test(node.props.accessibilityLabel ?? '')).length, 3, 'the three task slots are typeable steppers');
    assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 200), 'no fixed 200-point field');
    assert.ok(ui.ofType('View').some(node => node.props.style?.flexWrap === 'wrap'), 'the slot row wraps');
    assert.doesNotMatch(ui.text(), /Applied changes are listed|Recorded changes/, 'no sentence points at a removed section');
  } finally { done(); }
});

/** Wait for a re-render to show what the probe reads, one turn at a time. */
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('the dispatch limits did not settle');
}

/** Escape a string for a RegExp. */
function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('a frontier grant is one full-width row: planner, profiles, (?) and a revoke icon that asks first', async () => {
  const grant = { id: 'g1', planner: 'agent-1', reason: 'UI work', profiles: ['opus'], until: null, status: 'active', requestedAt: '2026-11-08T09:00:00.000Z', requestedBy: 'planner', decisionId: null, activatedAt: '2026-11-08T09:00:00.000Z', activatedBy: 'operator', runCount: 3 };
  const { ui, done } = await mountLimits({ state: state({ routingGrants: [grant], profiles: [{ id: 'opus', name: 'Opus Oracle' }], projects: [{ key: 'nucleus', name: 'nucleus', planner: { agentId: 'agent-1' } }] }) });
  try {
    const card = ui.get('Grant for nucleus planner, 3 runs');
    assert.equal(card.props.style.maxWidth, undefined, 'full width');
    assert.equal(card.props.style.flexBasis, undefined);
    assert.match(ui.text(), /nucleus planner[\s\S]*Opus Oracle/, 'planner then profiles');
    assert.equal(ui.query('Grant for nucleus planner actions'), undefined, 'no ⋯ menu');
    assert.ok(ui.get('Grant for nucleus planner help'));
    const revoke = ui.get('Revoke the grant for nucleus planner');
    assert.equal(revoke.props.accessibilityHint, 'Revoke the grant for nucleus planner');
    ui.press('Revoke the grant for nucleus planner');
    assert.match(ui.text(), /Revoke nucleus planner's grant\?/, 'revoking asks first');
    ui.press('Keep grant for nucleus planner');
    assert.doesNotMatch(ui.text(), /Revoke nucleus planner's grant\?/);
  } finally { done(); }
});

type Node = { type: string; props: Record<string, any>; children: Array<Node | string> };
/** The Text node whose content is exactly this string. */
const textNode = (ui: { ofType: (type: string) => Node[] }, content: string) =>
  ui.ofType('Text').find(node => node.children.join('') === content);
const contains = (node: Node, target: Node): boolean => node === target || node.children.some(child => typeof child !== 'string' && contains(child, target));
/** The innermost View holding every target (views come in document order, so the last match is the deepest). */
const sharedView = (ui: { ofType: (type: string) => Node[] }, ...targets: Node[]) =>
  ui.ofType('View').filter(view => targets.every(target => contains(view, target))).at(-1)!;
/** The View directly holding this node. */
const parentView = (ui: { ofType: (type: string) => Node[] }, target: Node) =>
  ui.ofType('View').find(view => view.children.includes(target))!;

test('a stacked number control puts its label on its own line and the control, with its unit, left-aligned below it', async () => {
  const { NumberStepper } = await import('../client/controls');
  const label = 'Lane drain escalation';
  const ui = mount(h(NumberStepper as never, { c, card: true, stacked: true, label, a11yLabel: `${label} dispatch limit (minutes, 1–10080)`, value: 1440, min: 1, max: 10080, unit: 'min', onChange: noop }));
  const text = textNode(ui, label)!;
  assert.ok(text, 'the label shows');
  assert.equal(text.props.style.flex, undefined, 'the label takes its own line, not a share of a row');
  assert.equal(text.props.style.flexShrink, undefined);
  const field = ui.get(`${label} dispatch limit (minutes, 1–10080)`);
  const row = sharedView(ui, field, textNode(ui, 'min')!);
  assert.equal(row.props.style.flexDirection, 'row', '− value + and the unit share one line');
  assert.equal(parentView(ui, row).props.style.justifyContent, 'flex-start', 'the control is left-aligned');
  const card = sharedView(ui, text, field);
  assert.notEqual(card.props.style.flexDirection, 'row', 'label above control, not beside it');
  assert.equal(card.props.style.flexBasis, 200, 'still a card');
  assert.equal(ui.get(`Increase ${label} dispatch limit (minutes, 1–10080)`).props.accessibilityRole, 'button');
});

test('an inline label never shrinks into its words: a tight card wraps the control under it', async () => {
  const { NumberStepper } = await import('../client/controls');
  const ui = mount(h(NumberStepper as never, { c, card: true, label: 'Coordinator', a11yLabel: 'coordinator demand offset', value: -2, min: -4, max: 4, onChange: noop }));
  const text = textNode(ui, 'Coordinator')!;
  assert.equal(text.props.style.flexShrink, 0, 'the label keeps its own width');
  assert.equal(text.props.style.maxWidth, '100%', 'and wraps only between words inside the card');
  const row = sharedView(ui, text, ui.get('coordinator demand offset'));
  assert.equal(row.props.style.flexDirection, 'row');
  assert.equal(row.props.style.flexWrap, 'wrap', 'the control wraps to the next line instead of squeezing the label');
});

test('Advanced limits stack every label; Task slots and Role demand keep theirs inline, at narrow and wide sizes', async () => {
  const { ui, done } = await mountLimits();
  try {
    ui.press('Advanced limits');
    for (const name of ['Paseo calls', 'Stall threshold', 'Hold reminder', 'Hold escalation', 'Lane drain', 'Lane drain escalation']) {
      const text = textNode(ui, name);
      assert.ok(text, `${name} shows`);
      assert.equal(text.props.style.flexShrink, undefined, `${name} is stacked: its label has its own line`);
    }
    for (const name of ['Global', 'Per project', 'Papercuts', 'Worker', 'Reviewer', 'Coordinator']) {
      const text = textNode(ui, name);
      assert.ok(text, `${name} shows`);
      assert.equal(text.props.style.flexShrink, 0, `${name} stays inline`);
    }
    assert.match(ui.text(), /Lane drain escalation[\s\S]*min/, 'the unit stays with the control');
  } finally { done(); }
});

test('a revealer centres its label and Show/Hide in one touch-target line, and its focus ring sits inside that line', async () => {
  const { Disclosure } = await import('../client/controls');
  const { space, touchTarget } = await import('../client/design');
  const longLabel = 'Diagnostics: identity, host process and output for a run with a very long name on a narrow board';
  let open = false;
  const ui = mount(h(Disclosure as never, { c, label: longLabel, expanded: open, onToggle: () => { open = !open; } }));
  const revealer = ui.get(longLabel);
  assert.equal(revealer.props.accessibilityRole, 'button');
  assert.equal(revealer.props.accessibilityState.expanded, false);
  const style = revealer.props.style;
  assert.equal(style.flexDirection, 'row');
  assert.equal(style.flexWrap, 'nowrap', 'a wrapping line packs to the top and leaves an empty band under the text');
  assert.equal(style.alignItems, 'center', 'label and Show/Hide sit in the middle of the touch target');
  assert.equal(style.minHeight, touchTarget, 'the touch target stays full height');
  assert.equal(style.maxWidth, '100%', 'a long label stays inside its column');
  assert.equal(style.marginTop, undefined, 'no gap unless the screen asks for one');
  assert.notEqual(style.marginTop, space.sm);
  assert.equal(textNode(ui, longLabel)!.props.style.flexShrink, 1, 'a long label wraps inside itself');
  assert.equal(textNode(ui, 'Show')!.props.style.flexShrink, 0, 'Show stays whole beside it');
  assert.equal(revealer.children.filter(child => typeof child !== 'string' && child.type === 'View').length, 0, 'no focus ring before focus');
  revealer.props.onFocus();
  const ring = ui.get(longLabel).children.find(child => typeof child !== 'string' && child.type === 'View') as Node | undefined;
  assert.ok(ring, 'focus draws the ring');
  assert.equal(ring.props.style.position, 'absolute', 'the ring is drawn inside the touch target itself');
  assert.equal(ring.props.style.top, 0);
  assert.equal(ring.props.style.bottom, 0);
});

test('Advanced limits has a gap above it, closed and open, and the advanced cards follow it', async () => {
  const { space, touchTarget } = await import('../client/design');
  const { ui, done } = await mountLimits();
  try {
    for (const expanded of [false, true]) {
      const revealer = ui.get('Advanced limits');
      assert.equal(revealer.props.accessibilityState.expanded, expanded);
      assert.equal(revealer.props.style.marginTop, space.sm, 'separated from the Task slots cards above');
      assert.equal(revealer.props.style.minHeight, touchTarget);
      assert.equal(revealer.props.style.flexWrap, 'nowrap');
      assert.ok(textNode(ui, expanded ? 'Hide' : 'Show'));
      if (!expanded) ui.press('Advanced limits');
    }
    const cards = sharedView(ui, ui.get('Paseo calls dispatch limit (calls, 1–32)'), ui.get('Lane drain dispatch limit (minutes, 1–10080)'));
    assert.equal(cards.props.style.marginTop, undefined, 'the advanced cards keep the section spacing');
    assert.equal(cards.props.style.gap, space.sm);
  } finally { done(); }
});

/* Task 1014: the usage level's end time is small text on the heading row's right, at High and Maximum only. */

const usage = (level: string, until: string | null = null) => ({ usage: { level, setLevel: level, until, expired: false } });
/** Mount Limits with a usage level and record each usage save. `fail` rejects every save. */
async function mountUsage(level: string, until: string | null = null, fail = false) {
  const saves: Array<{ level: string; until: string | null }> = [];
  const mounted = await mountLimits({ state: state(usage(level, until)), saveUsage: async (next: string, end: string | null) => {
    saves.push({ level: next, until: end });
    if (fail) throw new Error('usage write refused');
  } });
  return { ...mounted, saves };
}
const header = (ui: { ofType: (type: string) => Node[] }, title: string) =>
  ui.ofType('Text').find(node => node.props.accessibilityRole === 'header' && node.children.join('') === title)!;

test('Minimal, Low and Normal show no end time; the slider is the section body on its own', async () => {
  for (const level of ['minimal', 'low', 'normal']) {
    const { ui, done } = await mountUsage(level);
    try {
      assert.equal(ui.query(/^Return to Normal/), undefined, `${level}: no end-time link`);
      assert.doesNotMatch(ui.text(), /No end|until /, `${level}: no end-time text`);
      assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 200), `${level}: no fixed-width field`);
    } finally { done(); }
  }
});

test('High with no date reads "No end" as small muted text on the heading row, and the slider keeps its width', async () => {
  const { roles, type } = await import('../client/design');
  const { ui, done } = await mountUsage('high');
  try {
    const link = ui.get('Return to Normal: No end');
    assert.equal(link.props.accessibilityRole, 'button');
    const label = textNode(ui, 'No end')!;
    assert.equal(label.props.style.color, roles(c).muted, 'muted, not accent');
    assert.equal(label.props.style.fontSize, type.metadata.fontSize, 'metadata size');
    assert.equal(label.props.numberOfLines, 1);
    assert.equal(ui.ofType('TextInput').filter(node => /Return to Normal|until/.test(node.props.accessibilityLabel ?? '')).length, 0, 'no input box');
    assert.doesNotMatch(ui.text(), /Never/, 'the old caption and empty text are gone');
    // Same row as the section title, pushed to its right; on a narrow width it wraps and stays right-aligned.
    const row = sharedView(ui, header(ui, 'Usage level'), link);
    assert.equal(row.props.style.flexWrap, 'wrap', 'the heading row');
    const holder = parentView(ui, link)!;
    assert.equal(holder.props.style.marginLeft, 'auto');
    assert.equal(holder.props.style.maxWidth, '100%');
    // The slider is not beside the link: nothing shares a row with it in the section body.
    const slider = ui.get('Usage level slider, High');
    assert.ok(!contains(row, slider), 'the slider sits below the heading row');
    assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 200), 'no fixed-width field beside the slider');
  } finally { done(); }
});

test('High with a date reads "until <local time>" and lights up on hover', async () => {
  const { roles } = await import('../client/design');
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const shown = `until ${formatLocalDateTime(until)}`;
  const { ui, done } = await mountUsage('maximum', until);
  try {
    const link = ui.get(`Return to Normal: ${shown}`);
    assert.equal(textNode(ui, shown)!.props.style.color, roles(c).muted);
    link.props.onHoverIn();
    await settle(() => textNode(ui, shown)!.props.style.color === roles(c).accent);
    ui.get(`Return to Normal: ${shown}`).props.onHoverOut();
    await settle(() => textNode(ui, shown)!.props.style.color === roles(c).muted);
  } finally { done(); }
});

test('a long end-time label stays on one line inside the heading row, at narrow and wide sizes, and keeps its full accessible name', async () => {
  const { DateTimeLink } = await import('../client/date-time-field');
  const longPrefix = 'returns to Normal automatically at the end of the extended maintenance window, on ';
  const longEmpty = 'No end time is set, so this level stays in force until someone moves the slider back';
  const until = '2099-12-31T23:45:00.000Z';
  for (const width of [320, 1280]) {
    for (const value of [null, until]) {
      const shown = value ? `${longPrefix}${formatLocalDateTime(value)}` : longEmpty;
      const ui = mount(h('View', { style: { width } }, h(DateTimeLink as never, { c, label: 'Return to Normal', prefix: longPrefix, emptyText: longEmpty, value, onChange: () => undefined } as never)));
      try {
        const link = ui.get(`Return to Normal: ${shown}`);
        assert.equal(link.props.accessibilityRole, 'button');
        const text = textNode(ui, shown)!;
        assert.ok(text, `${width}: the whole text is rendered, the host truncates it`);
        assert.equal(text.props.numberOfLines, 1, `${width}: one line, never wrapping into the heading row`);
        assert.equal(link.props.style.flexShrink, 1, `${width}: the link shrinks before it overflows`);
        assert.equal(link.props.style.minWidth, 0);
        assert.equal(link.props.style.maxWidth, '100%', `${width}: never wider than its row`);
      } finally { ui.update(h('View', null)); }
    }
  }
  // In the section, the far-future date and its holder shrink too, so the title group keeps its space.
  const { ui, done } = await mountUsage('maximum', until);
  try {
    const link = ui.get(`Return to Normal: until ${formatLocalDateTime(until)}`);
    const holder = parentView(ui, link)!;
    assert.equal(holder.props.style.flexShrink, 1);
    assert.equal(holder.props.style.minWidth, 0);
    assert.equal(holder.props.style.maxWidth, '100%');
    assert.equal(textNode(ui, `until ${formatLocalDateTime(until)}`)!.props.numberOfLines, 1);
  } finally { done(); }
});

test('the link opens the shared picker; Clear and a picked time each save once with the level', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const { ui, saves, done } = await mountUsage('high', until);
  try {
    ui.press(`Return to Normal: until ${formatLocalDateTime(until)}`);
    await settle(() => Boolean(ui.query('Pick Return to Normal')));
    assert.ok(ui.text().includes('In 1 week'));
    ui.press('Clear');
    await settle(() => saves.length === 1);
    assert.deepEqual(saves[0], { level: 'high', until: null });
    await settle(() => Boolean(ui.query('Return to Normal: No end')));
    ui.press('Return to Normal: No end');
    await settle(() => Boolean(ui.query('Pick Return to Normal')));
    ui.press('In 3 days');
    ui.press('Done');
    await settle(() => saves.length === 2);
    assert.equal(saves[1].level, 'high');
    assert.ok(saves[1].until && Date.parse(saves[1].until) > Date.now());
    assert.equal(ui.query('Pick Return to Normal'), undefined, 'the picker closes');
    assert.ok(ui.query(`Return to Normal: until ${formatLocalDateTime(saves[1].until!)}`));
  } finally { done(); }
});

test('Cancel leaves the end time alone, and moving to Low drops the end time it can no longer show', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const { ui, saves, done } = await mountUsage('maximum', until);
  try {
    ui.press(/^Return to Normal: until /);
    await settle(() => Boolean(ui.query('Pick Return to Normal')));
    ui.press('Cancel');
    await settle(() => !ui.query('Pick Return to Normal'));
    assert.equal(saves.length, 0, 'Cancel saves nothing');
    ui.press('Usage High');
    await settle(() => saves.length === 1);
    assert.deepEqual(saves[0], { level: 'high', until }, 'High keeps the end time');
    ui.press('Usage Low');
    await settle(() => saves.length === 2);
    assert.deepEqual(saves[1], { level: 'low', until: null });
    assert.equal(ui.query(/^Return to Normal/), undefined);
  } finally { done(); }
});

test('a refused save shows Not saved and keeps the picked end time on screen', async () => {
  const { ui, saves, done } = await mountUsage('high', null, true);
  try {
    ui.press('Return to Normal: No end');
    await settle(() => Boolean(ui.query('Pick Return to Normal')));
    ui.press('In 1 day');
    ui.press('Done');
    await settle(() => saves.length === 1 && /Not saved/.test(ui.text()));
    assert.ok(ui.query(`Return to Normal: until ${formatLocalDateTime(saves[0].until!)}`), 'the draft stays, so the operator sees what failed');
  } finally { done(); }
});
