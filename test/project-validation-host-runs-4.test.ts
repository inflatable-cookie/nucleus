// Shard 4 of 8 of project-validation-host-runs.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(3, 8);
require('./project-validation-host-runs.cases');
