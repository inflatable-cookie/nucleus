// Shard 2 of 2 of responsible-lifecycle.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(1, 2);
require('./responsible-lifecycle.cases');
