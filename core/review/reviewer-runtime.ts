/**
 * Whether an observed reviewer runtime differs from its pinned profile. Provider
 * and model must be reported and match: they are the reviewer's identity for
 * exact-head review. Mode and thinking level refuse only on a reported, different
 * value; an unreported one is unknown, not changed (round 4, papercut 7d59b444:
 * Paseo 0.11.1 never reported a Claude agent's thinking option).
 */
export function reviewerRuntimeChanged(profile: { provider: string; model: string; modeId?: string; thinkingOptionId?: string },
  observed: { provider?: string | null; model?: string | null; modeId?: string | null; thinkingOptionId?: string | null } | undefined): boolean {
  const sameModel = (value: string | null | undefined) => (value ?? '').split('/').at(-1)?.toLowerCase();
  const differs = (pinned: string | undefined, actual: string | null | undefined) => pinned !== undefined && !!actual && actual !== pinned;
  return !observed?.provider || observed.provider !== profile.provider || !sameModel(observed.model) || sameModel(observed.model) !== sameModel(profile.model) ||
    differs(profile.modeId, observed.modeId) || differs(profile.thinkingOptionId, observed.thinkingOptionId);
}
