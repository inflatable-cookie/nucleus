import { test } from './support/sharded-test';
import { assertArchiveRefusals } from './support/review-source-terminal-archive-refusals';


// 'wrong-receipt' is retired with the external owner revision receipt (PR 843,
// task 595): an intake-provenance view binds to the accepted intake record, and
// emptying externalOwnerRevisions can no longer be a fault.
const faults = ['missing-event', 'discard-without-intent', 'failed-retirement', 'retirement-before-capture', 'failed-view-retirement',
  'dirty', 'index', 'untracked', 'foreign-origin', 'source-alias', 'source-recreated', 'foreign-thread', 'busy-thread', 'unpublished', 'missing-canonical', 'unreleased'] as const;
for (const fault of faults) {
  test(`terminal retry preserves the view for ${fault}`, async () => {
    await assertArchiveRefusals([fault]);
  });
}
