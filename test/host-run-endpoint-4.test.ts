// Shard 4 of 6 of host-run-endpoint.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(3, 6);
require('./host-run-endpoint.cases');
