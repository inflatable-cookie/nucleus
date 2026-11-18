import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newFindings } from '../scripts/check-retired-concepts.mjs';

test('baseline tolerates moved lines but not new or duplicate references', () => {
  const finding = { id: 'old', kind: 'term', needle: 'retired', file: 'example.ts', text: 'retired', line: 3 };
  const key = createHash('sha256').update(JSON.stringify(['old', 'term', 'retired', 'example.ts', 'retired'])).digest('hex');
  assert.deepEqual(newFindings([{ ...finding, line: 7 }], { [key]: 1 }), []);
  assert.deepEqual(newFindings([finding, finding], { [key]: 1 }), [finding]);
  const added = { ...finding, text: 'new retired' };
  assert.deepEqual(newFindings([added], { [key]: 1 }), [added]);
});
