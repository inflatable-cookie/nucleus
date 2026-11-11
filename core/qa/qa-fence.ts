/**
 * QA admission fence (papercut 26636095; Tom, 2026-10-22: "Build as designed
 * (Recommended)", "Operator + relay (Recommended)", "10 min default, 2 h cap
 * (Recommended)"). A host-wide, expiring fence on NEW project QA admissions
 * while an install owner swaps a shared tool. Admitted, queued and running QA,
 * accepted-request replays, joins of an active run, task validation and Effigy
 * client host runs are untouched. Spec 022 owns the rule.
 */
import { randomUUID } from "node:crypto";
import {
  isOperatorOrigin, projectQaFenceInputSchema, QA_FENCE_DEFAULT_MINUTES, QA_FENCE_REFUSAL_PREFIX,
  type ProjectQaFenceInput, type QaFence, type QaFenceRecord, type QaFenceStatus,
} from "../../shared/contracts";
import type { Store } from "../store/store";

type Authority = QaFenceRecord["clearedBy"] & {} & { kind: "operator" | "relayed_note" };

/** Only the operator, or a relaying agent carrying the operator's note, writes the fence. */
export function qaFenceAuthority(input: Pick<ProjectQaFenceInput, "caller" | "relayed" | "note">): Authority {
  const caller = input.caller.trim();
  if (input.relayed) {
    if (isOperatorOrigin(caller)) throw new Error("A relayed QA fence write names the relaying agent, not the operator");
    const note = input.note?.trim();
    if (!note) throw new Error("A relayed QA fence write requires the operator's authorization note");
    return { caller, kind: "relayed_note", note: note.slice(0, 4000) };
  }
  if (!isOperatorOrigin(caller))
    throw new Error(`Only the operator writes the QA admission fence, or a relaying agent with relayed true and the operator's authorization note; ${caller} has neither`);
  return { caller, kind: "operator", note: null };
}

/** The diagnostic every fenced admission records; the scheduler reads its prefix as a lifecycle refusal. */
export function qaFenceRefusal(fence: QaFence): string {
  return `${QA_FENCE_REFUSAL_PREFIX} until ${fence.until} (${fence.reason}); no QA run was created. Retry after it expires or the operator clears it`;
}

/** The fence view and the complete unsettled inventory, read in one transaction. */
export function qaFenceStatus(store: Store, at = Date.now()): QaFenceStatus {
  return store.transaction(() => ({ view: store.qaFenceView(at), inventory: store.qaUnsettledInventory(), readAt: new Date(at).toISOString() }));
}

/**
 * Set, replace or clear the fence under an optimistic revision, and return the
 * inventory from the same transaction. The expiry is absolute: nothing renews
 * it, and a retried write whose revision moved on is refused rather than
 * applied again.
 */
export function writeQaFence(store: Store, input: ProjectQaFenceInput, at = Date.now()): QaFenceStatus {
  const parsed = projectQaFenceInputSchema.parse(input);
  const by = qaFenceAuthority(parsed);
  return store.transaction(() => {
    const record = store.qaFenceRecord();
    if (record.revision !== parsed.expectedRevision)
      throw new Error(`The QA admission fence is at revision ${record.revision}, not ${parsed.expectedRevision}; read project.qa.fence-status and decide again. A retried write never renews, replaces or clears a newer fence`);
    const stamp = new Date(at).toISOString(), revision = record.revision + 1;
    if (parsed.action === "clear") {
      if (!store.qaFenceInForce(at)) throw new Error("No QA admission fence is in force");
      store.writeQaFence({ revision, fence: null, clearedAt: stamp, clearedBy: by,
        history: [...record.history, { action: "clear" as const, revision, at: stamp, by, fence: null }].slice(-20) });
    } else {
      const minutes = parsed.minutes ?? QA_FENCE_DEFAULT_MINUTES;
      const fence: QaFence = { id: randomUUID(), until: new Date(at + minutes * 60_000).toISOString(), reason: parsed.reason!.trim(), setAt: stamp, setBy: by };
      store.writeQaFence({ revision, fence, clearedAt: null, clearedBy: null,
        history: [...record.history, { action: "set" as const, revision, at: stamp, by, fence }].slice(-20) });
    }
    store.advanceRevision();
    return { view: store.qaFenceView(at), inventory: store.qaUnsettledInventory(), readAt: stamp };
  });
}
