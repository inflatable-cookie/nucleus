import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { LEAD_BODY_MAX, MAX_TITLE_LENGTH, type Lead, type LeadDetail, type LeadVersion, type LeadListInput, type LeadPage } from "../../shared/contracts";
import type { Store } from "../store/store";

type Repository = { origin: string; path: string };
type Location = { file: string; line: number };
export type LeadImportReport = { imported: Location[]; duplicate: Location[]; unparsed: (Location & { text: string })[] };

const now = () => new Date().toISOString();
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** One lead per file: the first heading outside frontmatter and code fences is the title; the rest is the body. */
export function parseLeadFile(content: string): { line: number; title: string; body: string } | null {
  const lines = content.split(/\r?\n/);
  let start = 0, fence = "";
  if (lines[0] === "---") { const end = lines.indexOf("---", 1); if (end > 0) start = end + 1; }
  for (let i = start; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ""; continue; }
    const heading = !fence && lines[i].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const title = heading[1].trim();
    // The heading and the blank line under it leave together, so the body reads as written.
    const rest = lines[i + 1]?.trim() === "" ? i + 2 : i + 1;
    const body = [...lines.slice(0, i), ...lines.slice(rest)].join("\n").trim();
    return { line: i + 1, title: title.length > 400 ? title.slice(0, 399).replace(/\s+\S*$/, "") + "…" : title, body };
  }
  return null;
}

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map(entry => join(path, entry.name)).sort();
}

export class Leads {
  constructor(private store: Store) {}
  private repositoryOf(repo: Repository): Repository { return this.store.resolveRepositoryIdentity(repo); }
  add(input: { repositories: Repository[]; title: string; body: string; baseBranch?: string; lanes: string[]; tags?: string[]; author: string }): Lead {
    return this.store.transaction(() => {
      if (input.title.trim().length > MAX_TITLE_LENGTH) throw new Error("Lead title must be 200 characters or fewer");
      if (input.tags?.includes("papercut")) throw new Error("Use papercut.add for the reserved papercut tag");
      const repositories = input.repositories.map(repo => this.repositoryOf(repo));
      this.store.requireRecordLanes(input.lanes, repositories);
      const stamp = now();
      return this.store.addLead({ id: randomUUID(), title: input.title, body: input.body, repositories, lanes: input.lanes, tags: input.tags ?? [], author: input.author,
        baseBranch: input.baseBranch ?? "main", state: "open", version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: null }, input.author);
    });
  }
  /** Edits are written against the latest version; a stale edit is refused and writes nothing. */
  edit(input: { id: string; version: number; title?: string; body?: string; baseBranch?: string; author: string }): Lead {
    return this.store.transaction(() => {
      if (input.title !== undefined && input.title.trim().length > MAX_TITLE_LENGTH) throw new Error("Lead title must be 200 characters or fewer");
      const current = this.store.lead(input.id);
      if (current.papercut) throw new Error("Use the papercut interface for papercut fields");
      if (current.state === "dropped") throw new Error("Dropped leads cannot be edited");
      if (current.version !== input.version) throw new Error(`Lead changed to version ${current.version}; reload before saving`);
      const title = input.title ?? current.title;
      const body = input.body ?? current.body;
      const baseBranch = input.baseBranch ?? current.baseBranch;
      if (title === current.title && body === current.body && baseBranch === current.baseBranch) return current;
      return this.store.updateLead({ ...current, title, body, baseBranch, version: current.version + 1,
        digest: undefined, check: null, checkOperationId: null, approval: null, updatedAt: now() }, input.author);
    });
  }
  get(input: { id: string }): Lead & { versions: LeadVersion[] } {
    return { ...this.store.lead(input.id), versions: this.store.leadVersions(input.id) };
  }
  getSummary(input: { id: string }): LeadDetail {
    const lead = this.store.lead(input.id);
    // The history read keeps every version but the current one's body never crosses the
    // store boundary (audit B7): a 541-version lead used to parse 137 MB of superseded text.
    const versions = this.store.leadVersionHistory(input.id, lead.version).map(version =>
      version.version === lead.version ? { ...version, approval: lead.approval } : version);
    const taskTargets = lead.targets.filter(target => target.kind === "task");
    return { ...lead, versions, promotedTaskId: taskTargets.length === 1 ? taskTargets[0].reference : null };
  }
  getVersion(input: { id: string; version: number }): LeadVersion {
    const lead = this.store.lead(input.id);
    const version = this.store.leadVersion(input.id, input.version);
    return version.version === lead.version ? { ...version, approval: lead.approval } : version;
  }
  list(input: LeadListInput & { pageSize: number }): LeadPage;
  list(input: LeadListInput): Lead[];
  list(input: LeadListInput): Lead[] | LeadPage {
    const rows = this.store.listLeads({ ...input, repository: input.repository ? normalizeRepositoryOrigin(input.repository) ?? input.repository : undefined });
    if (input.pageSize === undefined) {
      // An unpaged list that cannot fit one response refuses with what to send,
      // rather than failing at the 16 MiB transport bound (lean audit 2026-10-15:
      // all promoted leads were 27 MB). The array shape is kept below the bound.
      const total = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
      if (total > 12 * 1024 * 1024)
        throw new Error(`${rows.length} ${input.state ?? "open"} leads are ${(total / 1024 / 1024).toFixed(1)} MB, over one response; call lead.list with pageSize (1-8), then again with before set to the returned next cursor until next is null`);
      return rows;
    }
    // Leave headroom for the envelope/cursor under the unchanged 16 MiB RPC cap.
    const budget = 8 * 1024 * 1024;
    const singleRecordBudget = 16 * 1024 * 1024 - 64 * 1024;
    const items: Lead[] = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > budget) {
        if (!items.length) {
          if (size > singleRecordBudget) throw new Error(`Lead ${row.id} cannot fit the RPC response limit`);
          // Papercut metadata can repeat the body. Return a larger valid row alone.
          items.push(row);
        }
        break;
      }
      items.push(row); bytes += size;
    }
    const last = items.at(-1);
    const next = last && (items.length < rows.length || rows.length === input.pageSize)
      ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, next };
  }
  setLanes(input: { id: string; lanes: string[] }): Lead {
    return this.store.transaction(() => {
      const current = this.store.lead(input.id);
      this.store.requireRecordLanes(input.lanes, current.repositories);
      return this.store.updateLead({ ...current, lanes: input.lanes, updatedAt: now() });
    });
  }
  setTags(input: { id: string; tags: string[] }): Lead {
    return this.store.transaction(() => {
      const current = this.store.lead(input.id);
      if (input.tags.includes("papercut") && !current.papercut) throw new Error("Use papercut.add for the reserved papercut tag");
      if (current.papercut && !input.tags.includes("papercut")) throw new Error("The papercut tag is permanent for papercut records");
      return this.store.updateLead({ ...current, tags: input.tags, updatedAt: now() });
    });
  }
  drop(input: { id: string; reason: string }): Lead {
    return this.store.transaction(() => {
      const current = this.store.lead(input.id);
      if (current.papercut) throw new Error("Use papercut.close for papercuts");
      if (current.state !== "open") throw new Error(`Only open leads can be dropped; this lead is ${current.state}`);
      const stamp = now();
      return this.store.updateLead({ ...current, state: "dropped", dropReason: input.reason, updatedAt: stamp, closedAt: stamp });
    });
  }
  /**
   * Restores one dropped lead to open in place, so a mistaken drop needs no new lead, content edit,
   * approval substitution or private repair. Identity, title and body bytes, content version, saved
   * versions, checks, approval history, author, repositories, lanes and targets are untouched, no
   * version row is written, and the lead is editable again through the ordinary path. The reopen's
   * actor, time and reason, and the prior drop's reason and time, stay in durable history on the
   * lead even though the current dropped-state fields clear. Papercuts and any non-dropped state are
   * refused, and one transaction makes the guard and the write atomic.
   */
  reopen(input: { id: string; reason: string; author: string }): Lead {
    return this.store.transaction(() => {
      const current = this.store.lead(input.id);
      if (current.papercut) throw new Error("Papercut records are not reopened by lead.reopen");
      if (current.state !== "dropped") throw new Error(`Only dropped leads can be reopened; this lead is ${current.state}`);
      const stamp = now();
      return this.store.updateLead({ ...current, state: "open", dropReason: null, closedAt: null, updatedAt: stamp,
        reopens: [...current.reopens, { reason: input.reason, by: input.author, at: stamp,
          drop: { reason: current.dropReason, at: current.closedAt } }] });
    });
  }
  /** Hand promotion to a question or knowledge change. Each promotion adds a target; the lead counts as promoted from the first. */
  promote(input: { id: string; kind: "question" | "knowledge"; reference: string }): Lead {
    return this.store.transaction(() => {
      const current = this.store.lead(input.id);
      if (current.papercut) throw new Error("Use papercut.promote for papercuts");
      if (current.state === "dropped") throw new Error("Dropped leads cannot be promoted");
      if (current.targets.some(target => target.kind === input.kind && target.reference === input.reference)) return current;
      const stamp = now();
      return this.store.updateLead({ ...current, state: "promoted", targets: [...current.targets, { kind: input.kind, repository: null, reference: input.reference, at: stamp }],
        updatedAt: stamp, closedAt: current.closedAt ?? stamp });
    });
  }
  /**
   * Imports one file, or each Markdown file in a `docs/triage/` directory, as one lead titled by
   * its first heading. Idempotent on a content key over repository, title and body.
   */
  import(input: { repository: Repository; path: string; dryRun: boolean }): LeadImportReport {
    const run = (): LeadImportReport => {
      const report: LeadImportReport = { imported: [], duplicate: [], unparsed: [] };
      const repository = this.repositoryOf(input.repository);
      const seen = new Set<string>();
      for (const path of files(input.path)) {
        if (/^readme\.md$/i.test(path.split("/").at(-1)!)) { report.unparsed.push({ file: path, line: 1, text: "Directory index; not a lead" }); continue; }
        const parsed = parseLeadFile(readFileSync(path, "utf8"));
        if (!parsed) { report.unparsed.push({ file: path, line: 1, text: "No heading to title the lead" }); continue; }
        if (parsed.body.length > LEAD_BODY_MAX) { report.unparsed.push({ file: path, line: parsed.line, text: "Body exceeds 1 MB" }); continue; }
        const key = createHash("sha256").update(JSON.stringify([repository.origin, normalize(parsed.title), normalize(parsed.body)])).digest("hex");
        if (seen.has(key) || this.store.leadByContentKey(key)) { report.duplicate.push({ file: path, line: parsed.line }); continue; }
        seen.add(key);
        report.imported.push({ file: path, line: parsed.line });
        if (input.dryRun) continue;
        const stamp = now();
        this.store.addLead({ id: randomUUID(), title: parsed.title, body: parsed.body, repositories: [repository], lanes: [], author: "import",
          state: "open", version: 1, dropReason: null, targets: [], source: { file: path, contentKey: key }, createdAt: stamp, updatedAt: stamp, closedAt: null }, "import");
      }
      return report;
    };
    return input.dryRun ? run() : this.store.transaction(run);
  }
}
