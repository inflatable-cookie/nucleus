import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeContext } from '../core/intake/context';

test('intake ports stay restricted and read replacements at the call boundary', () => {
  const original = { name: 'original' };
  const replacement = { name: 'replacement' };
  const owner = {
    adapter: original,
    privateState: 1,
    update(value: number) { this.privateState += value; return this.privateState; },
  };
  const context = intakeContext(owner, ['adapter', 'update']);
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
