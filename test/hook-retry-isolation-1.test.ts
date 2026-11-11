// Shard 1 of 3 of hook-retry-isolation.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(0, 3);
require('./hook-retry-isolation.cases');
