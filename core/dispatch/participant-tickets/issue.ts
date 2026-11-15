/**
 * One issuance routine for every participant ticket. The three scopes — a
 * project's planner, one task's planner and a registered named agent — differ
 * only in what they are addressed by, the identity they are issued for, how that
 * identity stays current, and the message that carries the ticket. The write, the
 * two delivery routes (the caller's own response, or one host message to a thread
 * observed live) and the unknown-delivery record are the same for all three, so
 * they live here once.
 *
 * No send is ever repeated: a ticket whose delivery is unknown stays unknown, and
 * a record another call stored first is kept rather than overwritten.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Engine } from "../../engine";
import { writeOwnedJson } from "../../machine/owned-file.mjs";
import { digest } from "../../store/store";
import { hasTicket, readTicket, sameTicketIdentity, type TicketIdentity, type TicketRecord } from "./records";

/** One participant identity's ticket: where it is stored and what it is issued for. */
export interface TicketScope {
  /** The meta key the record is stored under. */
  key: string;
  /** Pending markers this ticket clears when it is written. */
  pending: readonly string[];
  /** The participant-id row that later resolves the id back to this scope. */
  index(participantId: string): readonly [key: string, value: unknown];
  /** The identity the ticket is issued for. */
  identity: TicketIdentity;
  /** Whether that identity is still current; read before the write and again inside it. */
  current(): boolean;
  /** The refusal when the identity changed between those two reads. */
  changed: string;
  /** The thread message that carries the ticket path. */
  message(participantId: string, path: string): { messageId: string; text: string };
  /** A failed send is thrown to the caller, or recorded on the queue and kept. */
  onFailure: "throw" | { taskId: string; kind: string };
}

function ticketPath(helperPath: string, participantId: string): string {
  const directory = join(dirname(helperPath), "tickets");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `participant-${participantId}.json`);
}

export async function issueTicket(
  engine: Engine,
  paths: { socketPath: string; helperPath: string },
  scope: TicketScope,
  route: "self" | "message",
): Promise<TicketRecord | undefined> {
  const store = engine.store;
  const stored = readTicket(store, scope.key);
  if (stored && sameTicketIdentity(stored, scope.identity)) return stored;
  // A key something else already holds is neither overwritten nor handed out:
  // only the ticket issued for this identity ever reaches its caller.
  if (hasTicket(store, scope.key)) return undefined;
  if (!scope.current()) return undefined;
  if (!engine.withHost(scope.identity.hostId, () => engine.hostAvailable(scope.identity.hostId))) return undefined;
  const participantId = randomUUID(), token = randomBytes(32).toString("hex");
  const path = ticketPath(paths.helperPath, participantId);
  const record: TicketRecord = { ...scope.identity, participantId, tokenHash: digest(token), path, delivery: route === "self" ? "self" : "intent" };
  writeOwnedJson(path, { socketPath: paths.socketPath, participantId, token });
  let written = false;
  store.transaction(() => {
    if (!scope.current()) throw Error(scope.changed);
    // A concurrent call stored a ticket for this key first: keep it and send
    // nothing, so one identity never holds two live tickets.
    if (hasTicket(store, scope.key)) return;
    store.setMeta(scope.key, record);
    const [indexKey, indexValue] = scope.index(participantId);
    store.setMeta(indexKey, indexValue);
    for (const marker of scope.pending) store.deleteMeta(marker);
    written = true;
  });
  if (!written) {
    // Another call issued this key while we were writing: hand back its ticket
    // only when it is the identity this call was for.
    const kept = readTicket(store, scope.key);
    return kept && sameTicketIdentity(kept, scope.identity) ? kept : undefined;
  }
  if (route === "self") return record;
  const stillOurs = () => readTicket(store, scope.key)?.participantId === participantId;
  try {
    await engine.withHost(record.hostId, () => engine.host.sendMessage(record.nativeAgentId, scope.message(participantId, path)));
    if (stillOurs()) store.setMeta(scope.key, { ...record, delivery: "delivered" });
  } catch (error) {
    if (stillOurs()) store.setMeta(scope.key, { ...record, delivery: "unknown" });
    if (scope.onFailure === "throw") throw error;
    store.event(scope.onFailure.taskId, scope.onFailure.kind, error instanceof Error ? error.message : String(error));
  }
  return record;
}
