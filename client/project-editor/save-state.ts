import { errorText } from "../error-text";
import React, { useRef, useState } from "react";
import { useSectionAutoSave } from "../controls";
import { withoutHostPaths } from "../project-helpers";
import type { SaveOp } from "./types";

export function useProjectSaves(refresh: () => Promise<unknown>) {
  const pending = useRef(new Map<string, SaveOp>());
  const inFlight = useRef(false);
  // Bumped when a batch lands cleanly with nothing behind it: the moment fields may take the server's values again.
  const [landed, setLanded] = useState(0);
  const auto = useSectionAutoSave<number>(async () => {
    inFlight.current = true;
    const batch = [...pending.current.values()];
    pending.current.clear();
    const failures: string[] = [];
    let refreshFailure: string | null = null;
    try {
      for (const op of batch) {
        try { await op.run(); } catch (error) { op.revert?.(); failures.push(withoutHostPaths(errorText(error))); }
      }
      try { await refresh(); }
      catch (error) { refreshFailure = `Saved, but refresh failed: ${withoutHostPaths(errorText(error))}`; }
    } finally { inFlight.current = false; }
    if (failures.length) throw new Error(failures.join("; "));
    if (refreshFailure) throw new Error(refreshFailure);
    if (!pending.current.size) setLanded(count => count + 1);
  });
  const [held, setHeld] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const clearHeld = (key: string) => setHeld(was => { if (!(key in was)) return was; const next = { ...was }; delete next[key]; return next; });
  const heldReason = Object.values(held)[0];
  return {
    status: heldReason ? `Not saved: ${heldReason}` : auto.status,
    /** Changes when fields may follow the server: a clean landing. Pair it with `quiet()` in a resync effect. */
    landed,
    /** Read inside an effect: nothing queued, in flight, failed or held back. */
    quiet: () => !inFlight.current && !pending.current.size && !auto.failed && !heldReason,
    queue(key: string, op: SaveOp, delay = 0) {
      pending.current.delete(key);
      pending.current.set(key, op);
      auto.enqueue(++sequence.current, delay);
      clearHeld(key);
    },
    /** Hold back a draft that cannot be sent, under its own key: other writes, even to the same record, never clear it. */
    hold(key: string, reason: string) { pending.current.delete(key); setHeld(was => ({ ...was, [key]: reason })); },
    /** A held draft became valid again. */
    release: clearHeld,
    flush: () => void auto.saver.flush(),
  };
}
