// Shard 2 of 5 of hooks.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(1, 5);
require('./hooks.cases');
