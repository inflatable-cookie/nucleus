// Shard 3 of 3 of fixture-ownership.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(2, 3);
require('./fixture-ownership.cases');
