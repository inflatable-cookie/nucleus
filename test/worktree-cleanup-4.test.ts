// Shard 4 of 5 of worktree-cleanup.cases.ts (see test/support/sharded-test.ts).
// require, not import: the shard must be set before the cases register their tests.
import { useShard } from './support/sharded-test';
useShard(3, 5);
require('./worktree-cleanup.cases');
