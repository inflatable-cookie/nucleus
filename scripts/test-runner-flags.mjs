/** Shared Node test runner shape for the parallel and wall-clock lanes. */
export const testEnvironmentImport = `--import=${new URL('./test-environment.mjs', import.meta.url).href}`;

export function runnerFlags(concurrency, timeout) {
  return ['--test', `--test-concurrency=${concurrency}`, `--test-timeout=${timeout}`, '--test-force-exit', testEnvironmentImport];
}
