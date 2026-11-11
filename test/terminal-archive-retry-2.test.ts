// Shard 2 of 3 of terminal-archive-retry.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(1, 3);
require('./terminal-archive-retry.cases');
