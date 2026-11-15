import type { Task } from "../../shared/contracts";
import { proofInputRedeclarationAllowed } from "../qa/proof-admission";
import { proofDeclarationSummary, proofReservation, sameProofDeclaration, spentProofExecution } from "../qa/proof-records";
import type { Store } from "../store/store";

/** One state transition the amendment records beside its own version pin. */
export type GateEvent = { kind: string; detail: string };

/**
 * Task 407/549: the accepted brief is the operative proof declaration. Its
 * selector stays immutable after reservation; input hashes may follow a corrected
 * source only after an authenticated revision and source approval. An amendment
 * that changes or removes a reserved selector, or re-declares inputs without that
 * proof, is refused by name and nothing is written. An unspent declaration is
 * cleared or replaced with no credit minted or moved.
 */
export function reconcileBriefProofDeclaration(input: {
  store: Store;
  task: Task;
  /** The declaration the amended document names; `undefined` when it says nothing about it. */
  declaredProof: Task['proofExecution'] | null | undefined;
  reason: string;
}): { changes: Partial<Task>; gateEvents: GateEvent[] } {
  const { store, task, declaredProof, reason } = input;
  const changes: Partial<Task> = {};
  const gateEvents: GateEvent[] = [];
  if (declaredProof === undefined) return { changes, gateEvents };
  const proofRuns = store.runs(task.id);
  const reservation = proofReservation(task, proofRuns);
  if (task.proofExecutionRetired && declaredProof)
    throw Error('This task retired its author-side proof declaration; a later amendment cannot name a selector again and nothing was written');
  if (task.proofExecutionRetired) {
    // The declaration stays retired through body-only/frontmatter amendments.
    return { changes, gateEvents };
  }
  if (declaredProof === null && task.proofExecution) {
    const spent = spentProofExecution(task, proofRuns);
    if (spent && spent.selector === task.proofExecution.selector && spent.settledAt && spent.status !== 'running' && spent.status !== 'unknown') {
      const uncertain = proofRuns.some(run => {
        if (run.role !== 'executor') return false;
        const receipt = task.proofExecutions.find(item => item.runId === run.id);
        return !run.released || !receipt || receipt.status === 'running' || receipt.status === 'unknown' || !receipt.settledAt;
      });
      if (uncertain)
        throw Error('This task cannot retire its author-side proof declaration while an executor run is live or uncertain; nothing was written');
      changes.proofExecution = undefined;
      changes.proofExecutionRetired = true;
      gateEvents.push({ kind: 'brief_proof_execution_retired', detail: `${proofDeclarationSummary({ selector: task.proofExecution.selector, inputs: task.proofExecution.inputs })}; ${reason}` });
    }
  }
  // Compare with the operative declaration first. A prior #549 amendment may have
  // re-declared inputs for a qualified new head, while the append-only reservation
  // still correctly records the original inputs. Keeping the current declaration
  // is a body-only amendment and needs no second re-declaration check.
  if (!changes.proofExecutionRetired && !sameProofDeclaration(declaredProof, task.proofExecution ?? null) && reservation) {
    if (!reservation.declaration || declaredProof?.selector !== reservation.declaration.selector)
      throw Error(`This task already reserved an author-side proof execution (${reservation.runId}, ${reservation.status}) for ${proofDeclarationSummary(reservation.declaration)}; the selector is immutable, so an amendment that changes or removes it is refused and nothing was written`);
    if (!sameProofDeclaration(declaredProof, reservation.declaration)) {
      const runs = store.runs(task.id);
      if (!task.prHead || !proofInputRedeclarationAllowed(task, runs, task.prHead))
        throw Error(`This task already reserved an author-side proof execution (${reservation.runId}, ${reservation.status}); input hashes may be re-declared only for a new head with an authenticated author revision and retained reviewer source approval, and nothing was written`);
      changes.proofExecution = declaredProof!;
      gateEvents.push({ kind: 'brief_proof_execution_changed', detail: `${proofDeclarationSummary(reservation.declaration)} → ${proofDeclarationSummary(declaredProof)} at ${task.prHead}; ${reason}` });
    }
  } else if (!changes.proofExecutionRetired && !reservation && !sameProofDeclaration(declaredProof, task.proofExecution ?? null)) {
    // Absent in the accepted brief clears an unspent declaration; a different one
    // replaces it. No execution exists either way, so no credit is minted or moved.
    changes.proofExecution = declaredProof ?? undefined;
    gateEvents.push({ kind: 'brief_proof_execution_changed', detail: `${proofDeclarationSummary(task.proofExecution ?? null)} → ${proofDeclarationSummary(declaredProof)}; ${reason}` });
  }
  return { changes, gateEvents };
}
