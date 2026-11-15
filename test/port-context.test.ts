import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enginePorts, portsContext } from '../core/port-context';

test('a port context stays restricted and reads replacements at the call boundary', () => {
  const original = { name: 'original' };
  const replacement = { name: 'replacement' };
  const owner = {
    adapter: original,
    privateState: 1,
    update(value: number) { this.privateState += value; return this.privateState; },
  };
  const context = portsContext(owner, ['adapter', 'update']);
  assert.deepEqual(Object.keys(context), ['adapter', 'update']);
  assert.equal('privateState' in context, false);
  assert.equal(context.adapter, original);
  owner.adapter = replacement;
  assert.equal(context.adapter, replacement);
  const scheduled = context.update;
  owner.update = function (value) { this.privateState += value * 2; return this.privateState; };
  // A retained delegate resolves the replacement at invocation and completes
  // synchronously with the owner's receiver, without a microtask boundary.
  assert.equal(scheduled(2), 5);
  assert.equal(owner.privateState, 5);
});

test('a shaped port is the value the root supplies and a write reaches the root', () => {
  const nested = { step: () => 'nested' };
  const owner = { value: 1, nested };
  const context = portsContext(owner, ['value'], { narrowed: nested });
  assert.deepEqual(Object.keys(context), ['value', 'narrowed']);
  assert.equal(context.narrowed, nested);
  context.value = 7;
  assert.equal(owner.value, 7, 'a context write is the root write, so a later read sees it');
  assert.equal(context.value, 7);
});

test('an engine context restricts the resolution ports it calls and keeps both live', () => {
  const resolution = { advance: () => 'first', privateState: 1 };
  const engine = { resolution, stopped: false };
  const context = enginePorts(engine, ['stopped'], ['advance']);
  assert.deepEqual(Object.keys(context), ['stopped', 'resolution']);
  assert.deepEqual(Object.keys(context.resolution), ['advance']);
  assert.equal('privateState' in context.resolution, false);
  assert.equal(context.resolution.advance(), 'first');
  resolution.advance = () => 'second';
  assert.equal(context.resolution.advance(), 'second', 'the nested context reads the root at each call');
});
