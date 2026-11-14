import { pidAlive } from "../machine/process-identity";
import { sourcePromotionOperationPayloadSchema } from "../../shared/contracts";
import type { QueueOperation } from "../../shared/operations";
import { now, operationIdForKey, operationInputHash, type Store } from "../store/store";

export const activeSourcePromotions = new Set<string>();
export const sourceOwnerKey = (id: string) => `sourcePromotionOwner:${id}`;
export const SOURCE_PROMOTION_NOT_DELIVERED = "Source promotion reconciled after restart: no task or source insert was committed";

/** A source insert and its lead target commit in one store transaction, so the target is an absence proof. */
export function reconcileSourcePromotion(store: Store, operation: QueueOperation, activeOperations: Set<string>): void {
  if (activeOperations.has(operation.id)) {
    store.transaction(() => {
      const current = store.operation(operation.id);
      if (current?.state !== 'running' || current.effect?.kind !== 'source_promotion') return;
      const diagnostic = 'Source promotion is still in flight; its outcome is uncertain';
      store.putOperation({ ...current, diagnostic, effect: { ...current.effect, status: 'uncertain', result: diagnostic, resultAt: now() } });
    });
    return;
  }
  if (operation.kind !== "source_promote" || !operation.effect || operation.effect.kind !== "source_promotion"
    || !["intent", "uncertain"].includes(operation.effect.status)) return;
  const payload = sourcePromotionOperationPayloadSchema.parse(store.operationPayload(operation.id));
  store.transaction(() => {
    const current = store.operation(operation.id);
    if (!current || current.kind !== "source_promote" || !["running", "needs_attention"].includes(current.state)
      || !current.effect || current.effect.kind !== "source_promotion"
      || current.effect.target !== current.id || !["intent", "uncertain"].includes(current.effect.status)
      || operationIdForKey(current.key) !== current.id || operationInputHash(payload) !== current.inputHash) return;
    const effect = current.effect;
    const result = store.sourcePromotionResult(payload.source, payload.source.repository,
      payload.source.version, payload.source.digest);
    if (result) {
      store.putOperation({ ...current, state: "succeeded", result, settledAt: now(), diagnostic: "",
        effect: { ...effect, status: "reconciled", result: "Committed task found from source identity", resultAt: now() } });
    } else {
      const owner = store.getMeta(sourceOwnerKey(current.id)) as { pid?: unknown } | null;
      const pid = typeof owner?.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
      // A recorded owner that is this process is proved not to be mid-commit
      // once no lane here is running it: the insert only happens inside that
      // operation's own handler, so absence now is absence for good.
      const idleHere = pid === process.pid && !activeSourcePromotions.has(current.id);
      const absent = pid !== null && (!pidAlive(pid) || idleHere);
      if (!absent) {
        const diagnostic = 'Source promotion outcome is uncertain: its executing process may still commit';
        store.putOperation({ ...current, state: current.state === 'running' && activeSourcePromotions.has(current.id) ? 'running' : 'needs_attention',
          diagnostic, effect: { ...effect, status: 'uncertain', result: diagnostic, resultAt: now() } });
        return;
      }
      store.putOperation({ ...current, state: "failed", result: null, settledAt: now(), diagnostic: SOURCE_PROMOTION_NOT_DELIVERED,
        effect: { ...effect, status: "reconciled", result: SOURCE_PROMOTION_NOT_DELIVERED, resultAt: now() } });
    }
  });
}
