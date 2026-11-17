/** BB's calling thread comes from its own thread-scoped environment. */
export function bbCallerIdentity(env = process.env) {
  const nativeAgentId = typeof env.BB_THREAD_ID === 'string' ? env.BB_THREAD_ID.trim() : '';
  const hasBbContext = ['BB_ENVIRONMENT_ID', 'BB_PROJECT_ID'].some(name =>
    typeof env[name] === 'string' && env[name].trim());
  if (!nativeAgentId && !hasBbContext) return null;
  if (!nativeAgentId)
    throw new Error('BB caller identity is incomplete; BB_THREAD_ID is required when BB thread context is present');
  return { hostKind: 'bb', nativeAgentId };
}
