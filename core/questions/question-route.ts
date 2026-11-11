import type { Adapter } from '../host/adapter';
import { supportsNativeQuestions } from './native-decision';

/** Where Nucleus-raised questions land for this host. */
export type QuestionRoute = 'native' | 'mcp_ask' | 'board';

export function questionRoute(
  adapter: Pick<Adapter, 'capabilities' | 'raiseTaskDecision' | 'reportingViaMcp'>,
  provider?: string | null,
): QuestionRoute {
  if (adapter.capabilities?.().nativeDecisions === false) return 'board';
  if (adapter.raiseTaskDecision && supportsNativeQuestions(provider)) return 'native';
  if (adapter.reportingViaMcp === false) return 'board';
  return 'mcp_ask';
}
