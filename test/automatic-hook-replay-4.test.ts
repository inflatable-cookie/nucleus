// Shard 4 of 4 of automatic-hook-replay.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(3, 4);
require('./automatic-hook-replay.cases');
