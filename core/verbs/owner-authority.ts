import { OPERATOR_BOARD_CALLER } from "../../shared/contracts";

/**
 * The authority a qualified owner acceptance needs, proved before anything is
 * written: the operator at the board, or an operator ruling relayed by an
 * authenticated caller with its recorded authorization note. (Spec 058 cutover
 * 5: the task project's owner thread is no longer an authority; project
 * ownership is retired, and a caller claiming it is refused like any other
 * non-authority.) A caller that only writes a reason, declares itself owner or
 * repeats a coordinatorAction has none, and an unattributed caller is refused
 * outright.
 */
export function assertOwnerAuthority(caller: string | undefined, relayed: boolean | undefined,
  relayNote: string | undefined, purpose = 'Qualified owner acceptance'):
  { role: 'operator' | 'authorized_relay'; kind: 'operator' | 'relayed_note'; note: string | null } {
  if (relayed) {
    const note = relayNote?.trim();
    if (!note) throw Error(`A relayed ${purpose.toLowerCase()} requires the recorded operator authorization note`);
    if (!caller) throw Error(`A relayed ${purpose.toLowerCase()} needs the relaying caller identity`);
    return { role: 'authorized_relay', kind: 'relayed_note', note: note.slice(0, 4000) };
  }
  if (!caller) throw Error(`${purpose} refuses an unattributed caller; the board or a relayed authorization note records it`);
  if (caller === OPERATOR_BOARD_CALLER) return { role: 'operator', kind: 'operator', note: null };
  throw Error(`${purpose} needs the operator at the board or a relayed operator authorization note; ${caller} has none`);
}

/**
 * Spec 058 (task 540): a delegated answer carries the answering agent as its
 * caller and the recorded delegation note. It is never the board and never
 * relayed; only the verbs that name it (merge acceptance, proof activation,
 * budget extension) accept it.
 */
export function assertDelegatedAuthority(caller: string | undefined, relayNote: string | undefined, purpose: string):
  { role: 'delegated'; kind: 'delegated'; note: string } {
  const note = relayNote?.trim();
  if (!note) throw Error(`A delegated ${purpose.toLowerCase()} requires the recorded delegation note`);
  if (!caller || caller === OPERATOR_BOARD_CALLER) throw Error(`A delegated ${purpose.toLowerCase()} needs the answering agent as its caller`);
  return { role: 'delegated', kind: 'delegated', note: note.slice(0, 4000) };
}
