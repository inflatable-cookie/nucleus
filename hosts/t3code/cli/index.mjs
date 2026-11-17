/** T3Code's environment names its own thread and the registered environment scope. */
export function t3codeCallerIdentity(env = process.env) {
  const nativeAgentId = typeof env.T3CODE_THREAD_ID === 'string' ? env.T3CODE_THREAD_ID.trim() : '';
  const hostScope = typeof env.T3CODE_DESKTOP_HOST_SCOPE === 'string' ? env.T3CODE_DESKTOP_HOST_SCOPE.trim() : '';
  if (!nativeAgentId && !hostScope) return null;
  if (!nativeAgentId || !hostScope)
    throw new Error('T3Code caller identity is incomplete; T3CODE_THREAD_ID and T3CODE_DESKTOP_HOST_SCOPE are both required');
  return { hostKind: 't3code', nativeAgentId, hostScope };
}
