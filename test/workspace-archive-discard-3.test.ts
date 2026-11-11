// Shard 3 of 4 of workspace-archive-discard.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(2, 4);
require('./workspace-archive-discard.cases');
