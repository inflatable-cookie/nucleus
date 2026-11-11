import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;
const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149', statusSuccess: '#3fb950' } as never;
const tick = () => new Promise(resolve => setImmediate(resolve));
const NOW = Date.parse('2026-11-09T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (ago: number) => new Date(NOW - ago).toISOString();
const stem = (ago: number, id: string) => `${at(ago).replace(/:/g, '-').replace('.', '-')}-${id}`;
// The live list shape: the tiers of one file share its stem, newest first per tier, sizes from stat.
const entry = (ago: number, id: string, kind: 'hourly' | 'daily' | 'weekly', extra: Record<string, unknown> = {}) =>
  ({ name: `${stem(ago, id)}.${kind}.sqlite.gz`, kind, at: at(ago), size: 37_512_448, verified: true as const, ...extra });
const liveList = () => ({
  snapshots: [
    entry(15 * 60_000, 'aaaa', 'hourly', { manual: true }),
    entry(6 * HOUR, 'bbbb', 'hourly'),
    entry(30 * HOUR, 'cccc', 'hourly'),
    entry(30 * HOUR, 'cccc', 'daily'),
    entry(30 * HOUR, 'cccc', 'weekly'),
    entry(6 * HOUR, 'bbbb', 'daily'),
  ],
  localError: null, dir: '/Volumes/example-volume/queue/backups', retention: { hourly: 24, daily: 14, weekly: 8 },
});

async function panel(props: Record<string, unknown>, width = 660) {
  const { BackupsPanel } = await import('../client/backups-panel');
  const base = { c: dark, list: liveList(), loading: false, loadError: null, health: { newestSnapshotAt: at(15 * 60_000), localError: null }, inset: 16, backUp: async () => {}, now: NOW };
  const ui = mount(h(BackupsPanel as never, { ...base, ...props }));
  ui.get('Store backups').props.onLayout({ nativeEvent: { layout: { width } } });
  return ui;
}
const snapshotLabels = (ui: Awaited<ReturnType<typeof panel>>) => ui.all(/^Snapshot /).map(node => node.props.accessibilityLabel as string);
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');

test('storage shows the resolved work root as selectable read-only text', async () => {
  const ui = await panel({ list: { ...liveList(), workRoot: '/workspace/nucleus/work' } });
  const root = ui.get('Work root');
  assert.equal(textOf(root), '/workspace/nucleus/work');
  assert.equal(root.props.selectable, true);
  assert.equal(root.type, 'Text');
  assert.match(ui.text(), /Storage.*Work root/s);
  ui.update(h('View'));
});

test('tiers sharing one file collapse into one row, and rows sort newest first', async () => {
  const { snapshotRows } = await import('../client/backups-panel');
  const rows = snapshotRows(liveList().snapshots);
  assert.equal(rows.length, 3, 'six names, three files');
  assert.deepEqual(rows.map(row => row.tiers), [['hourly'], ['hourly', 'daily'], ['hourly', 'daily', 'weekly']], 'tiers in hourly, daily, weekly order');
  assert.deepEqual(rows.map(row => row.at), [at(15 * 60_000), at(6 * HOUR), at(30 * HOUR)]);
  assert.deepEqual(rows.map(row => row.manual), [true, false, false]);
  // A daily that outlived its hourly (rotation removed the hourly) is still its own row.
  const orphan = snapshotRows([entry(5 * 24 * HOUR, 'dddd', 'daily'), entry(HOUR, 'eeee', 'hourly')]);
  assert.deepEqual(orphan.map(row => row.tiers), [['hourly'], ['daily']]);
});

test('a normal list: summary line, one row per file with date, age, size and tier labels, manual reads as manual', async () => {
  const ui = await panel({});
  const text = ui.text();
  assert.match(text, /Newest verified 15 min ago · next due \d\d:\d\d/);
  assert.doesNotMatch(text, /Restore/, 'no restore action on the page');
  const labels = snapshotLabels(ui);
  assert.equal(labels.length, 3);
  assert.match(labels[0], /15 min ago, 35\.8 MB, hourly, manual$/);
  assert.match(labels[1], /6 h ago, 35\.8 MB, hourly, daily$/);
  assert.match(labels[2], /30 h ago, 35\.8 MB, hourly, daily, weekly$/);
  assert.equal(ui.all(/^Snapshot /).length, 3);
  assert.equal(ui.query('Backups are failing'), undefined);
  assert.equal(ui.ofType('Text').filter(node => node.props.accessibilityRole === 'alert').length, 0, 'verified is the normal case: no warning');
  // Wide: each row is one line, the age column included.
  const first = ui.all(/^Snapshot /)[0];
  assert.equal(first.props.style.flexDirection, 'row');
  assert.match(textOf(first), /15 min ago/);
  assert.match(textOf(first), /hourly.*manual/);
  ui.update(h('View'));
});

test('the ? names the folder, the schedule, the retention and the restore procedure', async () => {
  const ui = await panel({});
  const tip = ui.get('Backups help');
  assert.match(tip.props.accessibilityHint, /\/Volumes\/example-volume\/queue\/backups/);
  assert.match(tip.props.accessibilityHint, /every 6 hours \(checked every 15 minutes\)/);
  assert.match(tip.props.accessibilityHint, /24 hourly, 14 daily and 8 weekly/);
  assert.match(tip.props.accessibilityHint, /docs\/knowledge\/operations\/restore\.md/);
  assert.equal(ui.query('Backups help text'), undefined);
  tip.props.onPress();
  assert.ok(ui.get('Backups help text'));
  ui.update(h('View'));
});

test('a stale newest snapshot reads as one warning line', async () => {
  const list = liveList();
  list.snapshots = list.snapshots.filter(item => !item.name.includes('aaaa'));
  list.snapshots = list.snapshots.map(item => item.name.includes('bbbb') ? { ...item, at: at(8 * HOUR) } : item);
  const ui = await panel({ list, health: { newestSnapshotAt: at(8 * HOUR), localError: null } });
  const alerts = ui.ofType('Text').filter(node => node.props.accessibilityRole === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(textOf(alerts[0]), 'Newest verified snapshot is 8 h old; one is due every 6 h');
  assert.match(ui.text(), /Newest verified 8 h ago · next due now/);
  assert.equal(snapshotLabels(ui).length, 2, 'the list still shows');
  ui.update(h('View'));
});

test('an error and an unavailable backup volume read as problems, with the reason', async () => {
  const outage = 'Backup volume unavailable: /Volumes/example-volume is not mounted (ENOENT)';
  const ui = await panel({
    list: { snapshots: [], localError: outage },
    health: { newestSnapshotAt: null, localError: outage },
  });
  const alerts = ui.ofType('Text').filter(node => node.props.accessibilityRole === 'alert');
  assert.equal(alerts.length, 1, 'one warning line');
  assert.equal(textOf(alerts[0]), `No verified snapshot: ${outage}`);
  assert.doesNotMatch(ui.text(), /No snapshots yet/, 'an outage is never an empty listing');
  assert.doesNotMatch(ui.text(), /Newest verified/);
  ui.update(h('View'));

  // A failure with snapshots still listed names the failure above them.
  const failing = await panel({ health: { newestSnapshotAt: at(15 * 60_000), localError: 'Snapshot integrity_check failed' } });
  const lines = failing.ofType('Text').filter(node => node.props.accessibilityRole === 'alert');
  assert.deepEqual(lines.map(textOf), ['Backups are failing: Snapshot integrity_check failed']);
  assert.equal(snapshotLabels(failing).length, 3);
  failing.update(h('View'));

  // A list that could not load says so, not "no snapshots".
  const unread = await panel({ list: undefined, loadError: new Error('service unreachable'), health: { newestSnapshotAt: null, localError: null } });
  assert.match(unread.text(), /No verified snapshot: Couldn't load the snapshot list: service unreachable/);
  unread.update(h('View'));
});

test('empty, loading and long content states', async () => {
  const empty = await panel({ list: { snapshots: [], localError: null }, health: { newestSnapshotAt: null, localError: null } });
  assert.match(empty.text(), /No snapshots yet/);
  assert.equal(empty.query('Stored snapshots'), undefined);
  empty.update(h('View'));

  const loading = await panel({ list: undefined, loading: true, health: undefined });
  assert.match(loading.text(), /Loading snapshots…/);
  assert.doesNotMatch(loading.text(), /No snapshots yet/);
  loading.update(h('View'));

  // A long reason wraps in full rather than truncating.
  const reason = `Backup storage unavailable: ${'/Volumes/example-volume/queue/backups/'.repeat(6)} could not be created (EACCES)`;
  const long = await panel({ health: { newestSnapshotAt: at(15 * 60_000), localError: reason } });
  const alert = long.ofType('Text').find(node => node.props.accessibilityRole === 'alert')!;
  assert.equal(alert.props.numberOfLines, undefined);
  assert.equal(alert.props.style.minWidth, 0);
  assert.match(textOf(alert), /\(EACCES\)$/);
  long.update(h('View'));

  // Many snapshots: every retained file has its row.
  const many = { ...liveList(), snapshots: Array.from({ length: 46 }, (_, i) => entry((i + 1) * HOUR, `a${String(i).padStart(3, '0')}`, 'hourly')) };
  const full = await panel({ list: many });
  assert.equal(snapshotLabels(full).length, 46);
  full.update(h('View'));
});

test('a phone-width panel puts the tier labels under the date; the settings width keeps one line', async () => {
  const narrow = await panel({}, 390);
  const row = narrow.all(/^Snapshot /)[0];
  assert.notEqual(row.props.style.flexDirection, 'row', 'narrow: stacked');
  assert.doesNotMatch(textOf(row), /min ago/, 'narrow: the age stays in the label and summary');
  assert.match(row.props.accessibilityLabel, /15 min ago/);
  narrow.update(h('View'));
  for (const width of [640, 700, 1100]) {
    const wide = await panel({}, width);
    assert.equal(wide.all(/^Snapshot /)[0].props.style.flexDirection, 'row', `${width}: one line`);
    wide.update(h('View'));
  }
});

test('Back up now shows progress while it runs, then the button returns', async () => {
  let finish!: () => void;
  const calls: number[] = [];
  const ui = await panel({ backUp: () => { calls.push(1); return new Promise<void>(resolve => { finish = resolve; }); } });
  ui.press('Back up now');
  assert.equal(calls.length, 1);
  const running = ui.get('Backing up…');
  assert.equal(running.props.disabled, true);
  finish();
  for (let i = 0; i < 10 && ui.query('Backing up…'); i++) await tick();
  assert.equal(ui.get('Back up now').props.disabled, false, 'the button returns once the snapshot and the refreshed list settle');
  ui.update(h('View'));
});
