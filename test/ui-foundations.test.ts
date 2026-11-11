import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs } from './support/render';

useNativeStubs();
const h = React.createElement;

const theme = {
  surface0: '#101010', surface1: '#181818', surface2: '#202020', border: '#333333',
  foreground: '#f0f0f0', foregroundMuted: '#9a9a9a', accent: '#4a90e2', accentForeground: '#ffffff',
  statusSuccess: '#4caf50', statusWarning: '#e0a800', statusDanger: '#d9534f',
} as const;
const c = theme as never;
const noop = () => undefined;

const design = () => import('../client/design');
const controls = () => import('../client/controls');

/** The focus ring is the only bordered, non-interactive overlay: a 2-point border with pointer events off. */
const focusRing = (ui: ReturnType<typeof mount>) => ui.ofType('View').find(node => node.props.pointerEvents === 'none' && node.props.style?.borderWidth === 2);

test('the spacing and type scales are the documented steps, with line height of at least 1.3', async () => {
  const d = await design();
  assert.deepEqual(Object.values(d.space), [4, 8, 12, 16, 24, 32]);
  for (const step of Object.values(d.type)) assert.ok(step.lineHeight >= step.fontSize * 1.3, `${step.fontSize}/${step.lineHeight} is too tight`);
  assert.deepEqual(Object.values(d.type).map(step => step.fontSize), [12, 14, 16, 20, 24]);
});

test('a visual smaller than the touch target gets a hit area that brings it to 44 points, split evenly', async () => {
  const d = await design();
  for (const visible of [14, 18, 30, 36, 44]) {
    const slop = d.touchSlop(visible);
    assert.equal(visible + slop.top + slop.bottom, Math.max(visible, d.touchTarget), `${visible} visible`);
    assert.equal(slop.top, slop.bottom);
    assert.equal(slop.left, slop.right);
  }
});

test('the colour roles read the host theme and keep the focus ring on the foreground role', async () => {
  const d = await design();
  const r = d.roles(c);
  assert.equal(r.canvas, theme.surface0);
  assert.equal(r.section, theme.surface1);
  assert.equal(r.raised, theme.surface2);
  assert.equal(r.danger, theme.statusDanger);
  assert.equal(r.onAccent, theme.accentForeground);
  assert.equal(r.focus, theme.foreground);
});

test('a button names its action, and its hint carries the reason it is unavailable to a screen reader', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Pause dispatch', hint: 'Dispatch is already paused', disabled: true, onPress: noop }));
  const node = ui.get('Pause dispatch');
  assert.equal(node.props.accessibilityHint, 'Dispatch is already paused');
  assert.equal(node.props.disabled, true);
  assert.equal(node.props.accessibilityState.disabled, true);
});

test('an icon-only button keeps its visible name as the accessible hint, and a long label wraps inside its row', async () => {
  const { Button } = await controls();
  const iconOnly = mount(h(Button, { c, text: 'Open board settings', label: 'Settings', icon: 'settings', iconOnly: true, hint: 'ignored on icon-only', onPress: noop }));
  assert.equal(iconOnly.get('Settings').props.accessibilityHint, 'Open board settings');
  const long = mount(h(Button, { c, text: 'Revoke and stop pinned retries for every planner on this host', wrap: true, onPress: noop }));
  const style = long.get('Revoke and stop pinned retries for every planner on this host').props.style;
  assert.equal(style.maxWidth, '100%');
  assert.equal(style.flexShrink, 1);
});

test('compact buttons keep their visual height and hit a 44-point target; the default button is already 44', async () => {
  const { Button } = await controls();
  const small = mount(h(Button, { c, text: '+', label: 'Raise worker demand', small: true, onPress: noop })).get('Raise worker demand');
  assert.equal(small.props.style.minHeight, 30);
  assert.equal(small.props.hitSlop.top, 7);
  const icon = mount(h(Button, { c, text: 'Settings', iconOnly: true, icon: 'settings', onPress: noop })).get('Settings');
  assert.equal(icon.props.style.minHeight, 36);
  assert.equal(icon.props.hitSlop.left, 4);
  const normal = mount(h(Button, { c, text: 'Save', onPress: noop })).get('Save');
  assert.equal(normal.props.style.minHeight, 44);
  assert.equal(normal.props.hitSlop.top, 0);
});

test('keyboard focus draws an inset ring inside the button and blur removes it, without changing the button size', async () => {
  const { Button } = await controls();
  const ui = mount(h(Button, { c, text: 'Save', onPress: noop }));
  assert.equal(focusRing(ui), undefined, 'no ring before focus');
  const before = ui.get('Save').props.style;
  ui.get('Save').props.onFocus();
  const ring = focusRing(ui);
  assert.ok(ring, 'a ring while focused');
  assert.equal(ring.props.style.borderColor, theme.foreground);
  assert.equal(ring.props.style.top, 0, 'inside the control, so no parent clips it');
  assert.equal(ring.props.style.borderRadius, 8);
  assert.deepEqual(ui.get('Save').props.style, before, 'focus does not restyle the control itself');
  ui.get('Save').props.onBlur();
  assert.equal(focusRing(ui), undefined, 'the ring goes on blur');
});

test('a selected or danger button takes its accent or danger role, with the matching foreground', async () => {
  const { Button } = await controls();
  const selected = mount(h(Button, { c, text: 'Replace', selected: true, onPress: noop })).get('Replace');
  assert.equal(selected.props.style.backgroundColor, theme.accent);
  assert.equal(selected.props.accessibilityState.selected, true);
  const danger = mount(h(Button, { c, text: 'Revoke', danger: true, onPress: noop })).get('Revoke');
  assert.equal(danger.props.style.backgroundColor, theme.statusDanger);
});

test('a limits section with no status shows no save element, and a failed save reads in the warning role', async () => {
  const { Section } = await controls();
  const idle = mount(h(Section, { c, title: 'Usage level', label: 'Usage level', status: '', children: h('View', null) }));
  assert.equal(idle.query('Usage level save status'), undefined);
  const failed = mount(h(Section, { c, title: 'Usage level', label: 'Usage level', status: 'Not saved: Hold reminder must be 1–10080 minutes', children: h('View', null) }));
  const failedStatus = failed.get('Usage level save status');
  assert.equal(failedStatus.props.style.color, theme.statusWarning);
  const saved = mount(h(Section, { c, title: 'Usage level', label: 'Usage level', status: 'Saved', children: h('View', null) }));
  assert.equal(saved.get('Usage level save status').props.style.color, theme.foregroundMuted);
});

test('a section that is saving keeps its title and controls, and shows no status while the save is in flight', async () => {
  const { Section } = await controls();
  const ui = mount(h(Section, { c, title: 'Role demand', label: 'Role demand offsets', status: 'Saving…', children: h('Text', null, 'worker 0') }));
  assert.equal(ui.get('Role demand offsets').props.accessibilityLabel, 'Role demand offsets');
  assert.equal(ui.query('Role demand save status'), undefined, 'Saving… stays quiet: autosave is the default (Tom, 2026-11-08)');
  assert.doesNotMatch(ui.text(), /Saving…/);
  assert.match(ui.text(), /worker 0/, 'the controls stay on screen while the save is in flight');
  const failed = mount(h(Section, { c, title: 'Role demand', label: 'Role demand offsets', status: 'Not saved: offset must be −4 to 4', children: h('Text', null, 'worker 0') }));
  assert.equal(failed.get('Role demand save status').props.accessibilityLiveRegion, 'polite');
  assert.equal(failed.get('Role demand save status').props.style.color, theme.statusWarning);
});

test('a long title, note and status wrap in the header row and never run past the section', async () => {
  const { Section } = await controls();
  const title = 'Frontier grants for every planner that asks for a frontier profile on this host';
  const note = 'Three planners hold grants with long reasons attached to them';
  const ui = mount(h(Section, { c, title, label: 'Frontier grants', note, status: 'Not saved: the grant store is unavailable and the change could not be recorded', children: h('View', null) }));
  const header = ui.get('Frontier grants').children[0] as unknown as { props: { style: Record<string, unknown> }; children: Array<{ props: { style: Record<string, unknown> } }> };
  assert.equal(header.props.style.flexWrap, 'wrap', 'the header row wraps on narrow layouts');
  // The title group and the title itself may shrink and wrap; a fixed title overflowed the section on a narrow layout.
  const group = header.children[0];
  assert.equal(group.props.style.maxWidth, '100%');
  assert.equal(group.props.style.flexShrink, 1);
  const titleNode = ui.ofType('Text').find(node => node.children.join('') === title);
  assert.equal(titleNode?.props.style.flexShrink, 1, 'a long title wraps instead of running past the section');
  const noteNode = ui.ofType('Text').find(node => node.children.join('') === note);
  assert.equal(noteNode?.props.style.maxWidth, '100%');
  assert.equal(noteNode?.props.style.flexShrink, 1);
  assert.equal(ui.get(`${title} save status`).props.style.maxWidth, '100%');
});

test('a section whose content ends in a row divider is set off by a wider gap, not a second line', async () => {
  const { Section } = await controls();
  const { space } = await design();
  const style = (props: Record<string, unknown>) => mount(h(Section, { c, title: 'Profiles', label: 'Profiles', ...props, children: h('Text', null, 'row') })).get('Profiles').props.style;
  const ruled = style({});
  assert.equal(ruled.borderBottomWidth, 1, 'a section ending in text keeps its divider');
  assert.equal(ruled.paddingBottom, space.md);
  const gap = style({ endsInRow: true });
  assert.equal(gap.borderBottomWidth, 0, 'no second line under the last row');
  assert.equal(gap.paddingBottom, space.lg, 'the boundary is a wider gap');
  assert.equal(gap.paddingTop, space.md);
  const last = style({ endsInRow: true, last: true });
  assert.equal(last.borderBottomWidth, 0);
  assert.equal(last.paddingBottom, space.md, 'the last section adds no trailing gap');
});

test('a section explanation opens behind its (?) on press and closes on the next press', async () => {
  const { Section } = await controls();
  const ui = mount(h(Section, { c, title: 'Frontier grants', label: 'Frontier grants', description: 'A planner asks once and you say yes on the board.', children: h('View', null) }));
  assert.equal(ui.query('Frontier grants help text'), undefined);
  ui.get('Frontier grants help').props.onPress();
  assert.equal(ui.get('Frontier grants help').props.accessibilityState.expanded, true);
  assert.match(JSON.stringify(ui.get('Frontier grants help text').children), /say yes on the board/);
  ui.get('Frontier grants help').props.onPress();
  assert.equal(ui.query('Frontier grants help text'), undefined);
});

test('a field shows focus in the focus role on its border, keeps the control height, and restores its border on blur', async () => {
  const { Field } = await controls();
  const { control } = await design();
  const ui = mount(h(Field, { c, label: 'Task title', value: '', onChange: noop, onBlur: noop, detail: 'Up to 120 characters' }));
  const input = ui.get('Task title');
  assert.equal(input.props.style.borderColor, theme.border);
  assert.equal(input.props.style.minHeight, control.height);
  input.props.onFocus();
  assert.equal(ui.get('Task title').props.style.borderColor, theme.foreground);
  assert.equal(ui.get('Task title').props.style.minHeight, control.height, 'focus never resizes the field');
  ui.get('Task title').props.onBlur();
  assert.equal(ui.get('Task title').props.style.borderColor, theme.border);
  assert.equal(ui.ofType('Text').find(node => node.children.join('') === 'Up to 120 characters')?.props.style.fontSize, 12);
});

test('one control size: the height sits between the old select and input, with a compact step below it', async () => {
  const d = await design();
  assert.ok(d.control.height >= 36 && d.control.height <= 40, `${d.control.height} is the middle ground`);
  assert.ok(d.control.height < d.touchTarget, 'below the touch target, so reach comes from hit slop');
  assert.ok(d.control.compact.height < d.control.height);
  assert.equal(d.control.text, d.type.body);
  assert.equal(d.control.compact.text, d.type.metadata);
  assert.equal(d.control.radius, d.radius.control);
  assert.equal(d.caption, d.type.metadata);
  for (const size of [d.control, d.control.compact]) assert.ok(size.height - 2 * d.control.border >= size.text.lineHeight, 'the value line fits inside the border');
});

/** The box a control paints: a text input's style, or a select trigger's. */
const box = (node: { props: Record<string, any> }) => {
  const { minHeight, paddingHorizontal, paddingVertical, borderRadius, borderWidth } = node.props.style;
  return { minHeight, paddingHorizontal, paddingVertical, borderRadius, borderWidth };
};

test('a text input, a select, a toggle and a stepper share one height, padding, value font, radius and border', async () => {
  const { Field, DropdownSelect, Button, NumberStepper } = await controls();
  const { control } = await design();
  const field = mount(h(Field, { c, label: 'Subscription', value: 'anthropic', onChange: noop })).get('Subscription');
  const selectUi = mount(h(DropdownSelect, { c, label: 'Provider', value: 'openai', options: [{ value: 'openai', label: 'OpenAI' }], onChange: noop }));
  const select = selectUi.get('Provider, OpenAI');
  assert.deepEqual(box(select), box(field), 'the select trigger has the text input\'s box');
  assert.equal(field.props.style.minHeight, control.height);
  assert.equal(field.props.style.paddingHorizontal, control.paddingX);
  assert.equal(field.props.style.borderRadius, control.radius);
  assert.equal(field.props.style.fontSize, control.text.fontSize);
  const value = selectUi.ofType('Text').find(node => node.children.join('') === 'OpenAI');
  assert.equal(value?.props.style.fontSize, field.props.style.fontSize, 'one value font');
  const toggle = mount(h(Button, { c, text: 'Pinned', label: 'Selection pinned', checked: false, matchField: true, onPress: noop })).get('Selection pinned');
  assert.equal(toggle.props.style.minHeight, control.height);
  assert.equal(toggle.props.style.borderRadius, control.radius);
  assert.equal(toggle.props.accessibilityRole, 'switch');
  const stepper = mount(h(NumberStepper, { c, a11yLabel: 'Weight', value: 3, min: 1, max: 10, onChange: noop }));
  for (const label of ['Decrease Weight', 'Increase Weight']) {
    const button = stepper.get(label);
    assert.equal(button.props.style.minHeight, control.height, `${label} at the control height`);
    assert.equal(button.props.style.minWidth, control.height, `${label} at least square`);
  }
  assert.equal(stepper.get('Weight').props.style.height, control.height, 'the number has the control height');
  assert.equal(stepper.get('Weight').props.style.fontSize, control.text.fontSize);
});

test('every control keeps a 44-point reach while its box stays at the control height', async () => {
  const { Field, DropdownSelect, Button } = await controls();
  const { control, touchTarget } = await design();
  const reach = (slop: { top: number; bottom: number }) => control.height + slop.top + slop.bottom;
  const fieldUi = mount(h(Field, { c, label: 'Name', value: '', onChange: noop }));
  const wrapper = fieldUi.ofType('Pressable').find(node => node.props.accessible === false);
  assert.ok(wrapper, 'the input sits in a reach wrapper that screen readers skip');
  assert.equal(reach(wrapper.props.hitSlop), touchTarget);
  const select = mount(h(DropdownSelect, { c, label: 'Model', value: '', placeholder: 'Choose a model', options: [], onChange: noop })).get('Model, Choose a model');
  assert.equal(reach(select.props.hitSlop), touchTarget);
  const toggle = mount(h(Button, { c, text: 'Pinned', matchField: true, onPress: noop })).get('Pinned');
  assert.equal(reach(toggle.props.hitSlop), touchTarget);
  const multiline = mount(h(Field, { c, label: 'Notes', value: '', multiline: true, onChange: noop }));
  assert.equal(multiline.get('Notes').props.style.minHeight, 120, 'a multiline field keeps its writing room');
  assert.equal(multiline.ofType('Pressable').find(node => node.props.accessible === false)?.props.hitSlop, undefined, 'and needs no slop');
});

test('one border rule: neutral at rest, the focus role on focus or open, never the accent for a value, and danger while invalid', async () => {
  const { Field, DropdownSelect } = await controls();
  const selectUi = mount(h(DropdownSelect, { c, label: 'Provider', value: 'openai', options: [{ value: 'openai', label: 'OpenAI' }], onChange: noop }));
  const trigger = () => selectUi.get('Provider, OpenAI');
  assert.equal(trigger().props.style.borderColor, theme.border, 'holding a value does not colour the select');
  trigger().props.onFocus();
  assert.equal(trigger().props.style.borderColor, theme.foreground);
  trigger().props.onBlur();
  assert.equal(trigger().props.style.borderColor, theme.border);
  selectUi.press('Provider, OpenAI');
  assert.equal(trigger().props.style.borderColor, theme.foreground, 'an open select shows the focus role');
  const invalid = mount(h(Field, { c, label: 'Subscription', value: '', invalid: true, onChange: noop }));
  assert.equal(invalid.get('Subscription').props.style.borderColor, theme.statusDanger);
  invalid.get('Subscription').props.onFocus();
  assert.equal(invalid.get('Subscription').props.style.borderColor, theme.statusDanger, 'an error keeps its colour through focus');
  const invalidSelect = mount(h(DropdownSelect, { c, label: 'Model', value: '', invalid: true, placeholder: 'Choose', options: [], onChange: noop }));
  assert.equal(invalidSelect.get('Model, Choose').props.style.borderColor, theme.statusDanger);
});

test('one caption style above every field, with or without a (?) beside it', async () => {
  const { Field, DropdownSelect, FieldCaption } = await controls();
  const { caption } = await design();
  const captionOf = (ui: ReturnType<typeof mount>, text: string) => ui.ofType('Text').find(node => node.children.join('') === text)?.props.style;
  const field = captionOf(mount(h(Field, { c, label: 'Subscription', value: '', onChange: noop })), 'Subscription');
  const select = captionOf(mount(h(DropdownSelect, { c, label: 'Provider', value: '', options: [], onChange: noop })), 'Provider');
  const helped = mount(h(FieldCaption, { c, text: 'Weight', help: 'Weight 2 receives roughly twice the assignments of weight 1.' }));
  const withHelp = captionOf(helped, 'Weight');
  for (const style of [field, select, withHelp]) {
    assert.equal(style?.fontSize, caption.fontSize);
    assert.equal(style?.lineHeight, caption.lineHeight);
    assert.equal(style?.color, theme.foregroundMuted);
  }
  assert.ok(helped.get('Weight help'), 'the (?) is there and named');
  const long = 'Reviewer profile group for every planner on this host';
  assert.equal(captionOf(mount(h(FieldCaption, { c, text: long, help: 'Help' })), long)?.flexShrink, 1, 'a long caption wraps beside its (?)');
});

test('compact selects stay compact, from the same tokens, with the caption only in the accessible label', async () => {
  const { DropdownSelect } = await controls();
  const { control } = await design();
  const ui = mount(h(DropdownSelect, { c, compact: true, label: 'Checks for acme/app', value: 'all', options: [{ value: 'all', label: 'All' }], onChange: noop }));
  const trigger = ui.get('Checks for acme/app, All');
  assert.equal(trigger.props.style.minHeight, control.compact.height);
  assert.equal(trigger.props.style.paddingHorizontal, control.compact.paddingX);
  assert.equal(trigger.props.style.borderRadius, control.radius);
  assert.equal(ui.ofType('Text').find(node => node.children.join('') === 'All')?.props.style.fontSize, control.compact.text.fontSize);
  assert.equal(ui.ofType('Text').find(node => node.children.join('') === 'Checks for acme/app'), undefined, 'no visible caption');
  const hidden = mount(h(DropdownSelect, { c, hideLabel: true, label: 'Checks', value: 'all', options: [{ value: 'all', label: 'All' }], onChange: noop }));
  assert.equal(hidden.get('Checks, All').props.style.minHeight, control.height, 'hideLabel drops the caption but keeps the full size');
  assert.equal(hidden.ofType('Text').find(node => node.children.join('') === 'Checks'), undefined);
});

test('a long select value stays on one line inside its trigger, and a disabled control dims without resizing', async () => {
  const { DropdownSelect, Field } = await controls();
  const { control } = await design();
  const long = 'claude-opus-5-5 with extended thinking on a very long model name';
  const ui = mount(h(DropdownSelect, { c, label: 'Model', value: 'x', disabled: true, options: [{ value: 'x', label: long }], onChange: noop }));
  const value = ui.ofType('Text').find(node => node.children.join('') === long);
  assert.equal(value?.props.numberOfLines, 1);
  assert.equal(value?.props.style.flexShrink, 1);
  assert.equal(ui.get(`Model, ${long}`).props.style.opacity, 0.45);
  assert.equal(ui.get(`Model, ${long}`).props.style.minHeight, control.height);
  const field = mount(h(Field, { c, label: 'Name', value: long, disabled: true, onChange: noop })).get('Name');
  assert.equal(field.props.style.opacity, 0.45);
  assert.equal(field.props.style.minHeight, control.height);
  assert.equal(field.props.accessibilityState.disabled, true);
});

test('a disclosure is a 44-point row that announces its expanded state and toggles its label', async () => {
  const { Disclosure } = await controls();
  const closed = mount(h(Disclosure, { c, label: 'Recorded changes', expanded: false, onToggle: noop }));
  const row = closed.get('Recorded changes');
  assert.equal(row.props.style.minHeight, 44);
  assert.equal(row.props.accessibilityState.expanded, false);
  const open = mount(h(Disclosure, { c, label: 'Recorded changes', expanded: true, onToggle: noop }));
  assert.equal(open.get('Recorded changes').props.accessibilityState.expanded, true);
  assert.match(open.text(), /Hide/);
});

test('muted text is the body size in the foreground-muted role', async () => {
  const { muted } = await controls();
  assert.equal(muted(c).fontSize, 14);
  assert.equal(muted(c).color, theme.foregroundMuted);
});
