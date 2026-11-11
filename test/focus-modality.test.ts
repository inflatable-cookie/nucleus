import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;

// A DOM host: the modality tracker listens on the document, as on the web board and the Paseo settings page.
type Listener = (event: Record<string, unknown>) => void;
const listeners = new Map<string, Set<Listener>>();
(globalThis as { document?: unknown }).document = {
  addEventListener: (type: string, listener: Listener) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener); },
  removeEventListener: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener); },
};
const fire = (type: string, event: Record<string, unknown> = {}) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); };
const click = () => { fire('pointerdown'); fire('mousedown'); };
const tab = () => fire('keydown', { key: 'Tab' });

const theme = {
  surface0: '#101010', surface1: '#181818', surface2: '#202020', border: '#333333',
  foreground: '#f0f0f0', foregroundMuted: '#9a9a9a', accent: '#4a90e2', accentForeground: '#ffffff',
  statusSuccess: '#4caf50', statusWarning: '#e0a800', statusDanger: '#d9534f',
} as const;
const c = theme as never;
const noop = () => undefined;
const controls = () => import('../client/controls');

type Ui = ReturnType<typeof mount>;
/** The focus ring: the bordered, non-interactive overlay. */
const focusRing = (ui: Ui) => ui.ofType('View').find(node => node.props.pointerEvents === 'none' && node.props.style?.borderWidth === 2);
/** Never clipped: the ring sits inside the control's own bounds. */
const assertInset = (ring: HostNode) => {
  for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(ring.props.style[side], 0, `${side} is inside the control`);
  assert.equal(ring.props.style.position, 'absolute');
  assert.equal(ring.props.style.borderColor, theme.foreground);
};

test('a button clicked into shows no ring; the same button reached with Tab shows an inset ring', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Close', onPress: noop }));
  click();
  ui.get('Close').props.onFocus();
  assert.equal(focusRing(ui), undefined, 'no ring after a click');
  ui.get('Close').props.onBlur();
  tab();
  ui.get('Close').props.onFocus();
  const ring = focusRing(ui);
  assert.ok(ring, 'a ring after Tab');
  assertInset(ring);
  assert.equal(ring.props.style.borderRadius, 8, 'the ring keeps the control radius');
  ui.get('Close').props.onBlur();
  assert.equal(focusRing(ui), undefined, 'the ring goes on blur');
});

test('a key pressed while a clicked control holds focus shows the ring, as :focus-visible does; a pointer press hides it again', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Save', onPress: noop }));
  click();
  ui.get('Save').props.onFocus();
  assert.equal(focusRing(ui), undefined);
  fire('keydown', { key: 'ArrowDown' });
  assert.ok(focusRing(ui), 'keyboard use reveals focus');
  fire('touchstart');
  assert.equal(focusRing(ui), undefined, 'a tap hides it');
});

test('a shortcut chord (Meta, Ctrl or Alt) is not keyboard navigation', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Copy', onPress: noop }));
  click();
  ui.get('Copy').props.onFocus();
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    fire('keydown', { key: 'c', [modifier]: true });
    assert.equal(focusRing(ui), undefined, `${modifier} keeps pointer modality`);
  }
});

test('a joined button\'s ring takes its square inner corners', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Run', joined: 'start', onPress: noop }));
  tab();
  ui.get('Run').props.onFocus();
  const ring = focusRing(ui)!;
  assertInset(ring);
  assert.equal(ring.props.style.borderTopRightRadius, 0);
  assert.equal(ring.props.style.borderBottomRightRadius, 0);
  assert.equal(ring.props.style.borderTopLeftRadius, 8);
});

test('a card\'s top-right icon buttons, focused by keyboard, draw the ring inside themselves', async () => {
  const { Button } = await controls();
  const ui = mount(h('View', { style: { overflow: 'hidden' } },
    h(Button, { c, iconOnly: true, icon: 'X', text: 'Close', label: 'Close task', onPress: noop })));
  tab();
  ui.get('Close task').props.onFocus();
  assertInset(focusRing(ui)!);
});

test('every ring control follows the modality: toggles, tabs, status glyphs, help tips and revealers', async () => {
  const { Button, TabRow, StatusGlyph, HelpTip, Disclosure } = await controls();
  const cases: Array<[string, React.ReactElement, number]> = [
    ['Auto-merge', h(Button, { c, text: 'Auto-merge', checked: true, onPress: noop }), 8],
    ['Planning', h(TabRow, { c, label: 'Sections', tabs: [{ id: 'tasks', text: 'Tasks' }, { id: 'planning', text: 'Planning' }], value: 'tasks', onChange: noop }), 8],
    ['Paused', h(StatusGlyph, { c, icon: 'Pause', color: theme.statusWarning, text: 'Paused', label: 'Paused' }), 10],
    ['Limits help', h(HelpTip, { c, label: 'Limits', text: 'Why', open: false, onOpenChange: noop }), 9],
    ['Diagnostics', h(Disclosure, { c, label: 'Diagnostics', expanded: false, onToggle: noop }), 8],
  ];
  for (const [label, element, corner] of cases) {
    const ui = mount(element);
    click();
    ui.get(label).props.onFocus();
    assert.equal(focusRing(ui), undefined, `${label}: no ring after a click`);
    ui.get(label).props.onBlur();
    tab();
    ui.get(label).props.onFocus();
    const ring = focusRing(ui);
    assert.ok(ring, `${label}: a ring after Tab`);
    assertInset(ring);
    assert.equal(ring.props.style.borderRadius, corner, `${label}: the ring keeps the control's radius`);
  }
});

test('a revealer pads its sides so the inset ring clears a long label', async () => {
  const { Disclosure } = await controls();
  const { space } = await import('../client/design');
  const label = 'Diagnostics: identity, host process and output for a run with a very long name on a narrow board';
  const ui = mount(h(Disclosure, { c, label, expanded: false, onToggle: noop }));
  assert.equal(ui.get(label).props.style.paddingHorizontal, space.xxs);
  assert.equal(ui.get(label).props.style.maxWidth, '100%', 'a long label stays inside a narrow column');
});

test('text fields keep their focus border after a click: it is not the ring', async () => {
  const { Field, NumberStepper, DropdownSelect } = await controls();
  click();
  const field = mount(h(Field, { c, label: 'Task title', value: '', onChange: noop }));
  field.get('Task title').props.onFocus();
  assert.equal(field.get('Task title').props.style.borderColor, theme.foreground, 'an input shows focus after a click');

  const stepper = mount(h(NumberStepper, { c, a11yLabel: 'Task slots', value: 3, min: 0, max: 8, onChange: noop }));
  stepper.get('Task slots').props.onFocus();
  const ring = focusRing(stepper);
  assert.ok(ring, 'the stepper number shows focus after a click');
  assertInset(ring);

  const select = mount(h(DropdownSelect, { c, label: 'Subscription', value: 'a', options: [{ value: 'a', label: 'A' }], onChange: noop }));
  select.get('Subscription, A').props.onFocus();
  assert.equal(select.get('Subscription, A').props.style.borderColor, theme.foreground, 'a select trigger shows focus after a click');
});

test('accessible names, roles and states never depend on the modality', async () => {
  const { Button } = await controls();
  const props = (ui: Ui) => { const { accessibilityRole, accessibilityLabel, accessibilityHint, accessibilityState } = ui.get('Remove task').props; return { accessibilityRole, accessibilityLabel, accessibilityHint, accessibilityState }; };
  const ui = mount(h(Button, { c, iconOnly: true, icon: 'Trash2', text: 'Remove', label: 'Remove task', onPress: noop }));
  click();
  ui.get('Remove task').props.onFocus();
  const pointer = props(ui);
  tab();
  assert.deepEqual(props(ui), pointer);
  assert.equal(pointer.accessibilityLabel, 'Remove task');
  assert.equal(pointer.accessibilityHint, 'Remove');
});

test('the browser\'s own outline is off wherever the ring or a focus border shows focus, so nothing draws outside a control', async () => {
  const { Button, StatusGlyph, HelpTip, Disclosure, Field, DropdownSelect } = await controls();
  const cases: Array<[string, () => React.ReactElement]> = [
    ['Close', () => h(Button, { c, text: 'Close', onPress: noop })],
    ['Paused', () => h(StatusGlyph, { c, icon: 'Pause', color: theme.statusWarning, text: 'Paused', label: 'Paused' })],
    ['Limits help', () => h(HelpTip, { c, label: 'Limits', text: 'Why', open: false, onOpenChange: noop })],
    ['Diagnostics', () => h(Disclosure, { c, label: 'Diagnostics', expanded: false, onToggle: noop })],
    ['Task title', () => h(Field, { c, label: 'Task title', value: '', onChange: noop })],
    ['Subscription, A', () => h(DropdownSelect, { c, label: 'Subscription', value: 'a', options: [{ value: 'a', label: 'A' }], onChange: noop })],
  ];
  // This file runs as a DOM host (React Native Web), where the outline is a browser style.
  for (const [label, element] of cases) {
    const style = mount(element()).get(label).props.style;
    assert.equal(style.outlineStyle, 'none', label);
    assert.equal(style.outlineWidth, 0, label);
  }
  // A native host has no browser outline, and no `none` value to give it.
  const host = globalThis as { document?: unknown };
  const dom = host.document;
  delete host.document;
  try {
    for (const [label, element] of cases) assert.equal(mount(element()).get(label).props.style.outlineStyle, undefined, label);
  } finally { host.document = dom; }
});

test('an icon button focused after a click shows no tooltip; Tab focus and hover show its own name (nucleus#982)', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, iconOnly: true, icon: 'X', text: 'Close', label: 'Close Remove Book', onPress: noop }));
  const tooltip = () => ui.ofType('Text').find(node => node.children.includes('Close'));
  click();
  ui.get('Close Remove Book').props.onFocus();
  assert.equal(tooltip(), undefined, 'a dialog opened by a click focuses Close without its tooltip');
  ui.get('Close Remove Book').props.onHoverIn();
  assert.ok(tooltip(), 'hover shows it');
  ui.get('Close Remove Book').props.onHoverOut();
  ui.get('Close Remove Book').props.onBlur();
  tab();
  ui.get('Close Remove Book').props.onFocus();
  assert.ok(tooltip(), 'Tab focus shows it');
  ui.get('Close Remove Book').props.onBlur();
  assert.equal(tooltip(), undefined, 'blur hides it');
});

test('only the focused control subscribes to modality changes, so a key or pointer press re-renders it alone (client audit C23)', async () => {
  const { Button } = await controls();
  const { modalitySubscriberCount } = await import('../client/focus-modality');
  const before = modalitySubscriberCount();
  const ui = mount(h('View', null, h(Button, { c, text: 'Focused', onPress: noop }), h(Button, { c, text: 'Idle', onPress: noop })));
  assert.equal(modalitySubscriberCount(), before, 'unfocused buttons do not subscribe');
  click();
  ui.get('Focused').props.onFocus();
  assert.equal(modalitySubscriberCount(), before + 1, 'the focused button subscribes');
  tab();
  assert.ok(focusRing(ui), 'the focused button still follows the modality');
  ui.get('Focused').props.onBlur();
  assert.equal(modalitySubscriberCount(), before, 'blur unsubscribes');
});
