import { randomUUID } from "node:crypto";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { Papercut } from "../../shared/contracts";
import { papercutBody } from "../../shared/papercut-lead";
import type { Store } from "../store/store";

export class Papercuts {
  constructor(private store: Store) {}
  add(input: { repository: Papercut["repository"]; area?: string; title: string; happened: string; impact: string; fix?: string; filedBy: string; filedAt?: string }): Papercut {
    const repository = this.store.resolveRepositoryIdentity(input.repository);
    return this.store.addPapercut({ id: randomUUID(), repository, area: input.area ?? null,
      title: input.title, happened: input.happened, impact: input.impact, fix: input.fix ?? null, filedBy: input.filedBy,
      filedAt: input.filedAt ?? new Date().toISOString(), state: "open", taskId: null, closedReason: null, note: null, closedAt: null, source: null });
  }
  list(input: { repository?: string; state?: Papercut["state"] }) {
    return this.store.listPapercuts({ ...input, repository: input.repository ? normalizeRepositoryOrigin(input.repository) ?? input.repository : undefined });
  }
  get(input: { id: string }) { return this.store.papercut(input.id); }
  /** Papercut content edits keep a versioned snapshot while preserving lifecycle and planning links. */
  edit(input: { id: string; version: number; title?: string; area?: string; happened?: string; impact?: string; fix?: string; author?: string }): Papercut {
    return this.store.transaction(() => {
      const current = this.store.papercut(input.id);
      if (current.version !== input.version) throw new Error(`Papercut changed to version ${current.version}; reload before saving`);
      if (input.title !== undefined && !input.title.trim()) throw new Error("Title must not be empty");
      if (input.happened !== undefined && !input.happened.trim()) throw new Error("What happened must not be empty");
      if (input.author !== undefined && !input.author.trim()) throw new Error("Author must not be empty");
      const title = input.title?.trim() ?? current.title;
      const area = input.area === undefined ? current.area : input.area.trim() || null;
      const happened = input.happened?.trim() ?? current.happened;
      const impact = input.impact?.trim() ?? current.impact;
      const fix = input.fix === undefined ? current.fix : input.fix.trim() || null;
      if (title === current.title && area === current.area && happened === current.happened && impact === current.impact && fix === current.fix)
        return current;
      const lead = this.store.lead(current.id);
      const body = papercutBody({ area, happened, impact, fix });
      this.store.preservePapercutVersion(lead, papercutBody(current));
      this.store.updateLead({ ...lead, title, body,
        papercut: { ...lead.papercut!, area, happened, impact, fix }, version: current.version + 1, updatedAt: new Date().toISOString() },
      input.author ?? "operator");
      return this.store.papercut(current.id);
    });
  }
  promote(input: { id: string; taskId?: string; reference?: string }): Papercut {
    const current = this.store.papercut(input.id);
    if (current.state !== "open") throw new Error("Only open papercuts can be promoted");
    const taskId = input.taskId ?? this.store.taskIdByNumber({ reference: input.reference });
    if (!this.store.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId) && !this.store.outcome(taskId)) throw new Error("Task not found");
    return this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId))
        this.store.update(taskId, { papercutTask: true }, "papercut_linked", current.id);
      return this.store.updatePapercut({ ...current, state: "promoted", taskId });
    });
  }
  /** Spec 026: the full lane list, checked whole against the papercut's repository. */
  setLanes(input: { id: string; lanes: string[] }): Papercut {
    return this.store.transaction(() => {
      const current = this.store.papercut(input.id);
      this.store.requireRecordLanes(input.lanes, [current.repository]);
      return this.store.updatePapercut({ ...current, lanes: input.lanes });
    });
  }
  close(input: { id: string; reason: "completed" | "deprecated"; note: string }): Papercut {
    const current = this.store.papercut(input.id);
    if (current.state === "closed") throw new Error("Papercut already closed");
    return this.store.updatePapercut({ ...current, state: "closed", closedReason: input.reason, note: input.note, closedAt: new Date().toISOString() });
  }
}
