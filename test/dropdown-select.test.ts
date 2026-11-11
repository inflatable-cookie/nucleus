import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { mount, useNativeStubs } from './support/render';

useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => '#123' }) as never;

type HarnessProps = {
  options: { value: string; label: string; group?: string }[];
  initial?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  compact?: boolean;
  changes?: string[];
};

async function harness(props: HarnessProps) {
  const { DropdownSelect } = await import('../client/controls');
  const changes = props.changes ?? [];
  function Harness() {
    const [value, setValue] = useState(props.initial ?? 'a');
    return h(DropdownSelect as never, {
      label: 'Choice', c: colors, options: props.options, value,
      placeholder: props.placeholder, disabled: props.disabled,
      emptyText: props.emptyText, compact: props.compact,
      onChange: (next: string) => { changes.push(next); setValue(next); },
    });
  }
  const ui = mount(h(Harness));
  return { ui, changes };
}

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

test('the menu opens under its trigger, ticks the current value and closes on choice', async () => {
  const { ui, changes } = await harness({ options });
  assert.ok(ui.get('Choice, Alpha'), 'the trigger names the current value');
  assert.equal(ui.query('Choice: Beta'), undefined, 'the menu starts closed');
  ui.press('Choice, Alpha');
  assert.equal(ui.get('Choice: Alpha').props.accessibilityState.selected, true, 'the current value is ticked');
  assert.equal(ui.get('Choice: Beta').props.accessibilityState.selected, false);
  assert.equal(ui.ofType('Modal').length, 0, 'the menu is anchored, never a dialog');
  ui.press('Choice: Beta');
  assert.deepEqual(changes, ['b'], 'choosing reports the value');
  assert.equal(ui.query('Choice: Beta'), undefined, 'choosing closes the menu');
  assert.ok(ui.get('Choice, Beta'), 'the trigger follows the new value');
  ui.update(h('View'));
});

test('the trigger toggles the menu and group headers, placeholders and empty text read plainly', async () => {
  const longLabel = `A very long option label that keeps going ${'and going '.repeat(20)}`;
  const grouped = [
    { value: 'a', label: 'Alpha', group: 'First' },
    { value: 'b', label: 'Beta', group: 'Second' },
    { value: 'c', label: longLabel, group: 'Second' },
  ];
  const picked = await harness({ options: grouped });
  picked.ui.press('Choice, Alpha');
  const headers = picked.ui.ofType('Text').filter(node => node.props.accessibilityRole === 'header');
  assert.deepEqual(headers.map(node => node.children.join('')), ['First', 'Second'], 'one header per group');
  assert.ok(picked.ui.get(`Choice: ${longLabel}`), 'a long option stays reachable by its label');
  const longText = picked.ui.ofType('Text').find(node => node.children.join('') === longLabel)!;
  assert.equal(longText.props.numberOfLines, 1, 'a long option truncates instead of widening the menu');
  picked.ui.press('Choice, Alpha');
  assert.equal(picked.ui.query('Choice: Beta'), undefined, 'another press of the trigger closes the menu');
  picked.ui.update(h('View'));

  const placeholder = await harness({ options: grouped, initial: 'zzz', placeholder: 'Pick one' });
  assert.ok(placeholder.ui.get('Choice, Pick one'), 'the placeholder shows when no option matches');
  placeholder.ui.update(h('View'));

  const empty = await harness({ options: [], initial: '', emptyText: 'Nothing to choose yet.' });
  empty.ui.press('Choice, ');
  assert.match(empty.ui.text(), /Nothing to choose yet/, 'the empty menu says what is absent');
  empty.ui.update(h('View'));

  const disabled = await harness({ options, disabled: true });
  assert.equal(disabled.ui.get('Choice, Alpha').props.disabled, true, 'a disabled trigger reports itself');
  assert.equal(disabled.ui.query('Choice: Beta'), undefined, 'a disabled trigger opens nothing');
  disabled.ui.update(h('View'));
});

test('Escape or an outside press closes the menu without choosing', async () => {
  const listeners = new Map<string, Set<(event: { key?: string; target?: unknown }) => void>>();
  (globalThis as unknown as { document: unknown }).document = {
    addEventListener: (type: string, listener: (event: { key?: string; target?: unknown }) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { key?: string; target?: unknown }) => void) => { listeners.get(type)?.delete(listener); },
  };
  try {
    const { ui, changes } = await harness({ options });
    const fire = (type: string, event: { key?: string; target?: unknown }) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); };
    ui.press('Choice, Alpha');
    assert.ok(ui.query('Choice: Beta'), 'the menu is open');
    fire('keydown', { key: 'Enter' });
    assert.ok(ui.query('Choice: Beta'), 'other keys leave the menu alone');
    fire('keydown', { key: 'Escape' });
    assert.equal(ui.query('Choice: Beta'), undefined, 'Escape closes the menu');
    assert.deepEqual(changes, [], 'Escape chooses nothing');
    ui.press('Choice, Alpha');
    fire('pointerdown', { target: {} });
    assert.equal(ui.query('Choice: Beta'), undefined, 'an outside press closes the menu');
    assert.deepEqual(changes, [], 'an outside press chooses nothing');
    assert.equal(ui.get('Choice, Alpha').props.accessibilityState.expanded, false);
    ui.update(h('View'));
  } finally {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});
