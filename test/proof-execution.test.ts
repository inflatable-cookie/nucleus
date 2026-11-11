// All cases register in this file; see test/support/sharded-test.ts.
import { useShard } from './support/sharded-test';
useShard(0, 1);
require('./proof-execution.cases');
