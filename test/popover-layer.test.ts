import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useRef, useState } from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;
const c = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149', statusSuccess: '#3fb950' } as never;
const noop = () => undefined;
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');

const contains = (node: HostNode, label: string): boolean => node.children.some(child => typeof child !== 'string' && (child.props.accessibilityLabel === label || contains(child, label)));

test('a popover goes below its anchor, aligned to its left edge, when there is room', async () => {
  const { placePopover } = await import('../client/popover');
  const layer = { x: 100, y: 50, width: 700, height: 800 };
  const placed = placePopover({ anchor: { x: 200, y: 100, width: 40, height: 30 }, layer, size: { width: 240, height: 120 }, viewport: { width: 1440, height: 900 } });
  assert.deepEqual(placed, { visible: true, side: 'below', edge: 'start', style: { left: 100, top: 84 } }, 'layer coordinates: 200 − 100 across, 100 + 30 + 4 − 50 down');
});

test('near the right edge a popover aligns to its anchor\'s right edge, and near the bottom it opens above', async () => {
  const { placePopover } = await import('../client/popover');
  const layer = { x: 0, y: 0, width: 780, height: 600 };
  // A narrow "+" trigger at the column's right edge with a 240-point menu.
  const right = placePopover({ anchor: { x: 740, y: 100, width: 32, height: 24 }, layer, size: { width: 240, height: 200 }, viewport: { width: 1440, height: 900 } });
  assert.equal(right.edge, 'end');
  assert.equal(right.style.right, 780 - 772, 'the menu\'s right edge meets the trigger\'s');
  assert.equal(right.style.left, undefined);
  const low = placePopover({ anchor: { x: 40, y: 540, width: 32, height: 24 }, layer, size: { width: 240, height: 200 }, viewport: { width: 1440, height: 900 } });
  assert.equal(low.side, 'above');
  assert.equal(low.style.bottom, 600 - 536, 'the popover\'s bottom sits a gap above the anchor');
  // The window can be shorter than the layer: the viewport bounds the flip too.
  const clipped = placePopover({ anchor: { x: 40, y: 380, width: 32, height: 24 }, layer: { x: 0, y: 0, width: 780, height: 2000 }, size: { width: 240, height: 200 }, viewport: { width: 1440, height: 520 } });
  assert.equal(clipped.side, 'above');
});

test('a popover too wide for either edge stays inside the column, and hides while its anchor is scrolled away', async () => {
  const { placePopover } = await import('../client/popover');
  const layer = { x: 0, y: 0, width: 360, height: 600 };
  const wide = placePopover({ anchor: { x: 150, y: 100, width: 40, height: 24 }, layer, size: { width: 340, height: 100 }, viewport: { width: 360, height: 900 } });
  assert.equal(wide.edge, 'start');
  assert.equal(wide.style.left, 12, 'shifted left until its right edge keeps the margin');
  const gone = placePopover({ anchor: { x: 150, y: -80, width: 40, height: 24 }, layer, size: { width: 200, height: 100 }, viewport: { width: 360, height: 900 } });
  assert.equal(gone.visible, false);
  const matched = placePopover({ anchor: { x: 20, y: 100, width: 300, height: 24 }, layer, size: { width: 120, height: 100 }, viewport: { width: 360, height: 900 }, matchAnchorWidth: true });
  assert.equal(matched.style.width, 300);
});

test('a popover whose anchor sits above later siblings renders in the overlay layer, not inside its card', async () => {
  const { PopoverHost, POPOVER_LAYER_ID } = await import('../client/popover');
  const { Section, DropdownSelect, Button } = await import('../client/controls');
  function Screen() {
    const [value, setValue] = useState('');
    return h(PopoverHost, null,
      h('View', { accessibilityLabel: 'Card' },
        h(Section, { c, title: 'Frontier grants', description: 'While a grant stands, this planner needs no per-task question.', children: h('Text', null, 'grant') }),
        h(DropdownSelect, { c, label: 'Add project limit override', value, placeholder: '+', compact: true, minWidth: 52, options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'A much longer project name' }], onChange: setValue }),
        h(Button, { c, iconOnly: true, icon: 'Trash2', text: 'Remove override', label: 'Project-A: Remove override', onPress: noop })),
      h('View', { accessibilityLabel: 'Recorded changes' }, h('Text', null, 'later sibling')));
  }
  const ui = mount(h(Screen));
  const layer = () => ui.ofType('View').find(node => node.props.testID === POPOVER_LAYER_ID)!;
  const card = () => ui.get('Card');
  assert.ok(layer(), 'the host mounts one layer');
  assert.equal(layer().props.pointerEvents, 'box-none', 'the layer passes presses through to the page');
  assert.equal(layer().props.style.zIndex, 1000);
  assert.equal(layer().children.length, 0, 'nothing open, nothing in the layer');

  ui.press('Frontier grants help');
  assert.ok(contains(layer(), 'Frontier grants help text'), 'the help panel is in the layer');
  assert.ok(!contains(card(), 'Frontier grants help text'), 'and not inside the card');
  ui.press('Frontier grants help');
  assert.equal(ui.query('Frontier grants help text'), undefined, 'closing removes it from the layer');

  ui.press('Add project limit override, +');
  assert.ok(contains(layer(), 'Add project limit override: Alpha'), 'the dropdown menu is in the layer');
  assert.ok(!contains(card(), 'Add project limit override: Alpha'));
  const box = layer().children[0] as HostNode;
  assert.equal(box.props.style.minWidth, 160, 'the menu is never as narrow as its tiny trigger');
  assert.equal(box.props.style.maxWidth, 360, 'it grows with its longest option up to a cap');
  assert.equal(box.props.style.opacity, 0, 'unplaced until its anchor is measured');
  ui.press('Add project limit override: A much longer project name');
  assert.equal(layer().children.length, 0, 'choosing closes the menu and clears the layer');

  ui.get('Project-A: Remove override').props.onHoverIn();
  assert.equal(textOf(layer()), 'Remove override', 'the icon button tooltip is in the layer');
  assert.ok(!textOf(card()).includes('Remove override'), 'and not inside the card');
  ui.update(h('View'));
});

test('outside a host a popover renders in place, as before', async () => {
  const { Popover } = await import('../client/popover');
  function Owner() {
    const anchor = useRef(null);
    return h('View', { ref: anchor, accessibilityLabel: 'Owner' }, h(Popover, { anchor, inlineStyle: { top: '100%', left: 0 }, children: h('Text', { accessibilityLabel: 'Inline content' }, 'x') }));
  }
  const ui = mount(h(Owner));
  assert.ok(contains(ui.get('Owner'), 'Inline content'));
  ui.update(h('View'));
});
