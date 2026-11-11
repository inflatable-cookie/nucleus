// Host load can explain a measured performance assertion, never a functional,
// timeout, cancellation or runner failure. Missing reporter evidence fails closed.
export function timingVerdict({ status, loads, cores, strict = false, failures, failed, cancelled }) {
  if (status === 0) return { verdict: "pass", exit: 0 };
  const load = Math.max(...loads);
  const onlyPerformance = status === 1 && cancelled === 0 && failed > 0
    && Array.isArray(failures) && failures.length === failed
    && failures.every(failure => failure.performance === true);
  if (onlyPerformance && load > cores && !strict)
    return { verdict: "inconclusive", exit: 0, load };
  return { verdict: "fail", exit: status || 1, load };
}

/** Node wraps a thrown assertion in ERR_TEST_FAILURE; inspect only its direct cause. */
export function timingFailure(data) {
  const error = data.details?.error;
  if (error?.failureType === "subtestsFailed") return null; // parent echo, not another failed oracle
  return { name: data.name, performance: error?.failureType === "testCodeFailure"
    && error?.cause?.code === "NUCLEUS_PERFORMANCE_ORACLE" };
}
