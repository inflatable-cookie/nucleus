import { test } from "node:test";
import assert from "node:assert/strict";
import { completionSchema } from "../shared/contracts";

/**
 * Papercut 8647384e: intake's `reviewedInputs` refusal is read by a reviewer whose
 * turn stays open, so it must name the exact entry, field and expected shape. The
 * same entry recorded twice is harmless and is de-duplicated; two entries that
 * claim different content for one path still refuse, naming both.
 */
test('reviewedInputs names a malformed entry and de-duplicates harmless repeats', () => {
  const completion = (reviewedInputs: unknown) => ({ eventId: 'e', taskId: 't', runId: 'r', status: 'blocked', summary: 's', reviewedInputs });
  const digest = 'b'.repeat(64);
  assert.deepEqual(completionSchema.parse(completion([
    { path: 'plans/a.md', sha256: digest }, { path: 'plans/a.md', sha256: digest }, { directory: 'plans' }, { directory: 'plans' },
  ])).reviewedInputs, [{ path: 'plans/a.md', sha256: digest }, { directory: 'plans' }]);
  assert.throws(() => completionSchema.parse(completion([{ directory: 'plans' }, { path: 'plans/a.md', sha256: 'b'.repeat(63) }])),
    /reviewedInputs\[1\] sha256 must be 64 lowercase hexadecimal characters/);
  assert.throws(() => completionSchema.parse(completion([{ path: 'plans/a.md', count: 2 }])),
    /reviewedInputs\[0\] must be exactly one of \{path, sha256\}, \{directory\}, \{glob\} or \{digest, count\}/);
  assert.throws(() => completionSchema.parse(completion([{ path: 'plans/a.md', sha256: digest }, { path: 'plans/a.md', sha256: 'c'.repeat(64) }])),
    /reviewedInputs\[1\]\.sha256 differs from reviewedInputs\[0\]\.sha256 for path plans\/a\.md/);
  assert.throws(() => completionSchema.parse(completion(Array.from({ length: 513 }, (_, index) => ({ directory: `plans/${index}` })))),
    /Summarise reviewedInputs as directories or a digest/);
});
