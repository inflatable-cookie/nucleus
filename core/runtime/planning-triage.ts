import { TriageService, type TriageApplyResult, type TriageDecision, type TriagePromotionRequest, type TriagePromotionResult } from "../planning/triage";
import type { Store } from "../store/store";

/**
 * The async half of triage apply (nucleus#1420). A planner's promote disposition runs through
 * the ordinary check, approval and promotion operations, with the planner recorded as approver
 * and promoting agent. Everything else settles synchronously inside the triage ledger.
 */
export interface TriagePromoter {
  /** Promotes one record the planner chose, returning a proposed or applied result. */
  promote(request: TriagePromotionRequest): Promise<TriagePromotionResult>;
}

export interface TriageApplyInput {
  project: string;
  batch: string;
  by: string;
  decisions: TriageDecision[];
}

export async function applyTriage(store: Store, promoter: TriagePromoter, input: TriageApplyInput): Promise<TriageApplyResult> {
  const service = new TriageService(store);
  const begun = service.begin(input);
  if (begun.result) return begun.result;
  const results: Array<{ request: TriagePromotionRequest; result: TriagePromotionResult | { error: string } }> = [];
  for (const request of begun.promotions) {
    try {
      results.push({ request, result: await promoter.promote(request) });
    } catch (error) {
      results.push({ request, result: { error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return service.finish({ project: input.project, batch: input.batch, results });
}
