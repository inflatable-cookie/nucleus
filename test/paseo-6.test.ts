// Shard 6 of 8 of paseo.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(5, 8);
require('./paseo.cases');
