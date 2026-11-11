// Shard 3 of 6 of service.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(2, 6);
require('./service.cases');
