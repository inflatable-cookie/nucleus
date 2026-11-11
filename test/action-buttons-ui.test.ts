import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import React from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';

/**
 * nucleus#999: one icon-only button per common action. Each action has one icon,
 * a tooltip and an accessible label naming the action and its object; text stays
 * where an icon would be ambiguous.
 */

useNativeStubs();
const h = React.createElement;
const theme = {
  surface0: '#101010', surface1: '#181818', surface2: '#202020', border: '#333333',
  foreground: '#f0f0f0', foregroundMuted: '#9a9a9a', accent: '#4a90e2', accentForeground: '#ffffff',
  statusSuccess: '#4caf50', statusWarning: '#e0a800', statusDanger: '#d9534f',
} as const;
const c = theme as never;
const noop = () => undefined;
const controls = () => import('../client/controls');

/** The icon a button draws. */
const iconOf = (node: HostNode): string | undefined => {
  if (node.type === 'Icon') return node.props.name;
  for (const child of node.children) if (typeof child !== 'string') { const found = iconOf(child); if (found) return found; }
  return undefined;
};
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');

test('each common action has its own icon', async () => {
  const { ACTION_ICONS } = await controls();
  assert.deepEqual(ACTION_ICONS, {
    add: 'Plus', remove: 'Trash2', duplicate: 'Copy', edit: 'Pencil', refresh: 'RefreshCw', close: 'X',
    moveInto: 'FolderInput', pause: 'Pause', resume: 'Play', primary: 'Star',
  });
  const icons = Object.values(ACTION_ICONS);
  assert.equal(new Set(icons).size, icons.length, 'no two actions share an icon');
});

test('an action button is icon-only, names the action and its object, and shows the name as its tooltip on hover and keyboard focus', async () => {
  const { ActionButton, ACTION_ICONS } = await controls();
  for (const action of Object.keys(ACTION_ICONS) as (keyof typeof ACTION_ICONS)[]) {
    const ui = mount(h(ActionButton, { c, action, label: `${action} Opus Oracle`, onPress: noop }));
    const node = ui.get(`${action} Opus Oracle`);
    assert.equal(node.props.accessibilityRole, 'button');
    assert.equal(iconOf(node), ACTION_ICONS[action], `${action} draws its one icon`);
    assert.equal(textOf(node), '', `${action} shows no text at rest`);
    assert.equal(node.props.accessibilityHint, `${action} Opus Oracle`, 'a screen reader hears the tooltip');
  }
  const ui = mount(h(ActionButton, { c, action: 'add', label: 'Add profile', onPress: noop }));
  ui.get('Add profile').props.onHoverIn();
  assert.match(ui.text(), /Add profile/, 'hover shows the tooltip');
  ui.get('Add profile').props.onHoverOut();
  assert.doesNotMatch(ui.text(), /Add profile/);
});

test('an action button keeps the 44-point reach, never takes the danger fill, and says why it is unavailable', async () => {
  const { ActionButton } = await controls();
  const { control, touchTarget } = await import('../client/design');
  let pressed = 0;
  const ui = mount(h(ActionButton, { c, action: 'remove', label: 'Remove Opus Oracle', onPress: () => { pressed++; } }));
  const node = ui.get('Remove Opus Oracle');
  assert.equal(node.props.style.minHeight, control.height);
  assert.equal(node.props.style.minWidth, control.height);
  assert.equal(control.height + node.props.hitSlop.top + node.props.hitSlop.bottom, touchTarget);
  assert.equal(node.props.style.backgroundColor, theme.surface2, 'a removal confirms in its danger colour; the icon stays neutral');
  ui.press('Remove Opus Oracle');
  assert.equal(pressed, 1);
  const blocked = mount(h(ActionButton, { c, action: 'remove', label: 'Remove acme/app', tip: 'Move ★ to another repository first', disabled: true, onPress: noop })).get('Remove acme/app');
  assert.equal(blocked.props.accessibilityState.disabled, true);
  assert.equal(blocked.props.accessibilityHint, 'Move ★ to another repository first', 'the tooltip carries the reason');
});

test('a busy action spins its icon and cannot be pressed again', async () => {
  const { ActionButton } = await controls();
  const node = mount(h(ActionButton, { c, action: 'refresh', label: 'Refresh providers and models', tip: 'Refreshing providers and models…', busy: true, onPress: noop })).get('Refresh providers and models');
  assert.equal(iconOf(node), 'LoaderCircle');
  assert.equal(node.props.accessibilityState.disabled, true);
});

test('a long label stays a one-line tooltip and the button keeps its square size', async () => {
  const { ActionButton, control } = { ...(await controls()), control: (await import('../client/design')).control };
  const label = 'Remove the A very long project name that would otherwise wrap across a narrow settings column override';
  const ui = mount(h(ActionButton, { c, action: 'remove', label, onPress: noop }));
  ui.get(label).props.onHoverIn();
  const tooltip = ui.ofType('Text').find(node => textOf(node) === label)!;
  assert.equal(tooltip.props.numberOfLines, 1);
  assert.equal(ui.get(label).props.style.minWidth, control.height);
});

/** The client sources: every shared surface both shells mount. */
const sources = readdirSync(new URL('../client/', import.meta.url)).filter(name => name.endsWith('.tsx'))
  .map(name => ({ name, text: readFileSync(new URL(`../client/${name}`, import.meta.url), 'utf8') }));

test('common actions go through ActionButton: no hand-built icon button draws one of their icons', async () => {
  const { ACTION_ICONS } = await controls();
  const icons = Object.values(ACTION_ICONS).join('|');
  for (const { name, text } of sources) {
    if (name === 'controls.tsx') continue;
    assert.doesNotMatch(text, new RegExp(`<Button[^>]*iconOnly[^>]*icon="(${icons})"`), `${name}: an icon-only Button with a common action's icon`);
    assert.doesNotMatch(text, new RegExp(`<Button[^>]*icon="(${icons})"[^>]*iconOnly`), `${name}: an icon-only Button with a common action's icon`);
    assert.doesNotMatch(text, /<Pressable[^>]*accessibilityLabel="(Close detail|Dismiss error)"/, `${name}: a hand-built close`);
  }
});

test('Add, Edit, Duplicate and Refresh never show as text buttons', () => {
  for (const { name, text } of sources) {
    assert.doesNotMatch(text, /<Button[^>]*\btext="(Add|Edit|Duplicate|Refresh|Edit plan|Add to plan)"/, `${name}: a text button for a common action`);
  }
});

test('the board header gains nothing: Settings, Refresh and Pause stay its only controls', async () => {
  const { headerControls } = await import('../shared/queue-navigation');
  assert.deepEqual(headerControls(false, true, false).map(control => control.id), ['settings', 'refresh', 'pause']);
});
