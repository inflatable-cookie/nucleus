/**
 * The native question wire (raise, read, answer) lives in `host/paseo/host-questions.ts`.
 * This module keeps the provider list that core routing reads synchronously.
 *
 * Spec 058 (task 550): which providers can raise a native Paseo question at all.
 * Today only Codex exposes `request_user_input_async`; pi workers (GLM, Deepseek)
 * have no native question surface, so Queue delivers questions on them by
 * prompting the thread to call `nucleus_ask` instead. Extend the set only when
 * Paseo maps another provider's question tool onto the permission surface.
 */
export function supportsNativeQuestions(provider: string | null | undefined): boolean {
  return provider === 'codex';
}
