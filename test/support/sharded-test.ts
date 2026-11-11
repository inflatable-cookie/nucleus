import { test as nodeTest } from 'node:test';
import type { TestContext } from 'node:test';

/**
 * Runs one shard of a long case file. A case file imports `test` from here
 * instead of node:test; each `<name>-<k>.test.ts` calls `useShard(k, n)` and then
 * imports the cases. Every shard replays the same registration order and gives
 * each case to the least-loaded shard (lowest index on a tie), so every case
 * registers in exactly one shard. Equal weights make that round robin; a case
 * whose fixture work is several ordinary cases registers through
 * `weighted(w)` so it does not stack with other heavy cases. Files run in
 * parallel and tests inside one file don't, so this cuts the suite's critical
 * path without moving any test code. Git-, hook- and executor-heavy families use it
 * so aggregate fixture work stays inside the parallel unit file's 120 s budget at
 * `--test-concurrency=6`.
 */
let shard = { index: 0, count: 1 }, loads = [0];
export function useShard(index: number, count: number) { shard = { index, count }; loads = new Array(count).fill(0); }
/** The shard this physical file registered; prefix-isolated fixtures append it. */
export function currentShard(): { index: number; count: number } { return shard; }
function register(weight: number, args: Parameters<typeof nodeTest>) {
  const target = loads.indexOf(Math.min(...loads));
  loads[target] += weight;
  return target === shard.index ? nodeTest(...args) : undefined;
}
export function weightedTiming(registerTiming: (name: string, options: { timeout?: number; skip?: string | false }, fn: (t: TestContext) => void | Promise<void>) => void) {
  return (weight: number) => (name: string, options: { timeout?: number; skip?: string | false }, fn: (t: TestContext) => void | Promise<void>) => {
    const target = loads.indexOf(Math.min(...loads));
    loads[target] += weight;
    return target === shard.index ? registerTiming(name, options, fn) : undefined;
  };
}
export const test = ((...args: Parameters<typeof nodeTest>) => register(1, args)) as typeof nodeTest;
/** A case that costs about `weight` ordinary cases of its family. */
export const weighted = (weight: number) => ((...args: Parameters<typeof nodeTest>) => register(weight, args)) as typeof nodeTest;
