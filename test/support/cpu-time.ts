/** CPU consumed by this test process, including synchronous SQLite work. A host
 * deschedule does not count as Queue work. Timing-lane files run alone in their
 * own process, so this covers the code under test without other test files. */
export function cpuTimeMs(since: NodeJS.CpuUsage): number {
  const elapsed = process.cpuUsage(since);
  return (elapsed.user + elapsed.system) / 1_000;
}

export function cpuSample<T>(run: () => T): { value: T; ms: number } {
  const started = process.cpuUsage();
  const value = run();
  return { value, ms: cpuTimeMs(started) };
}
