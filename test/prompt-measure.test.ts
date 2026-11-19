import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureRunPrompt } from '../core/dispatch/prompt-text/measure';

test('prompt size records count rendered sections without retaining text', () => {
  const { prompt, size } = measureRunPrompt(section =>
    `${section('brief', 'brief')} ${section('report', 'brief rules')} ${section('brief', 'brief')}!`);
  assert.equal(prompt, 'brief brief rules brief!');
  assert.deepEqual(size, { total: 24, sections: { brief: 10, report: 11, roleInstructions: 3 } });
  assert.doesNotMatch(JSON.stringify(size), /brief rules/);
});
