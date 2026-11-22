import { stopClearedPatch } from "../../shared/task-stop";
import type { Task, TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { receiptAcceptanceRefusal } from "../review/proof-receipt-acceptance";
import { now } from "../store/store";
import { assertOwnerAuthority } from "./owner-authority";

/**
 * `accept_receipt`: the operator's acceptance of one passing proof receipt as
 * release evidence for the exact head. It keeps the original reviewer verdict
 * and failed qualification as history, appends the acceptance to every
 * completion notice, and marks the receipt-only result passed. Nothing is
 * re-run and no verdict is rewritten.
 */
export function applyReceiptAcceptance(engine: Engine, input: TaskControlInput, operated: <T>(result: T) => T): Task {
  if (input.delegated) throw Error("Receipt acceptance requires the operator, not a delegated answer");
  const authority = assertOwnerAuthority(input.caller, input.relayed, input.note, "Receipt acceptance");
  const reason = input.reason?.trim();
  if (!reason) throw Error("Receipt acceptance requires a reason");
  return engine.store.transaction(() => {
    const current = engine.store.task(input.taskId);
    if (current.proofReceiptAcceptance) return current;
    engine.requireOwnerControlCurrent(current, input.version, 'Task changed; refresh before accepting the receipt');
    const refusal = receiptAcceptanceRefusal(current);
    if (refusal) throw Error(refusal);
    const receipt = current.proofExecutions.at(-1)!;
    const originalResult = current.proofOnlyResult!;
    const acceptance = { acceptedBy: input.caller!, acceptedAt: now(), reason, runId: receipt.runId,
      commit: receipt.head, selector: receipt.selector, inputs: receipt.inputs, originalResult,
      authorization: { role: authority.role, note: authority.note } };
    const detail = `Operator ${acceptance.acceptedBy} accepted passing receipt ${receipt.runId} as release evidence: ${reason}. Original reviewer verdict and failed qualification: ${originalResult.evidence}`;
    for (const notice of engine.store.notices(current.id).filter(item => item.kind === 'completion')) {
      const text = `${notice.text}\nOperator accepted receipt ${receipt.runId} as release evidence: ${reason}\nOriginal failed qualification and reviewer verdict: ${originalResult.evidence}`;
      if (notice.status === 'pending') engine.store.putNotice({ ...notice, text });
      else if (!notice.id.endsWith(':receipt-acceptance')) {
        const id = `${notice.id}:receipt-acceptance`;
        if (!engine.store.notices(current.id).some(item => item.id === id)) engine.store.putNotice({ ...notice, id, status: 'pending', error: '', text });
      }
    }
    const accepted = `Operator accepted receipt ${receipt.runId} as release evidence; original failed qualification remains in history`;
    return engine.store.update(current.id, { ...stopClearedPatch(engine.store.task(current.id), accepted), proofReceiptAcceptance: acceptance,
      proofOnlyResult: { ...originalResult, status: 'passed', evidence: `Operator accepted receipt ${receipt.runId} as release evidence. ${receipt.evidence}`.slice(0, 4000) },
      reason: accepted },
      'proof_receipt_accepted', detail);
  });
}
