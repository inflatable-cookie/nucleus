import { resolve } from "node:path";
import { repositorySettingsSchema, repositoryMatchSpecificity, DEFAULT_REPOSITORY_CHECKS_POLICY, type HostKind, type ProjectCloseout, type ProjectQa, type ProjectValidation, type RepositoryChecksPolicy, type RepositorySettings, type Task, type WorkspaceProvider } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { repositoryRekeyInputSchema, repositoryRekeyReceiptSchema, type RepositoryRekeyInput, type RepositoryRekeyPreview, type RepositoryRekeyPreviewInput, type RepositoryRekeyReceipt, type RepositoryRekeyReceiptQuery, type RepositoryRekeyResult } from "../../shared/repository-rekey";
import { repositoryScratchNamespace } from "../workspaces/run-scratch";
import { applyRepositoryRekey as applyRekey, previewRepositoryRekey as previewRekey } from "../planning/repository-rekey";
import { digest, now, operationInputHash, StoreCore } from "./store-core";
import { type StoreProjectRegistry } from "./store-project-registry";

/** Spec 022: a repository settings row is keyed by the repository identity — origin when known, else the local path. */
export const repositoryKey = (identity: RepositorySettings["repository"]): string => identity.origin ?? identity.path;

interface RepositorySettingsAccess {
  /** Drops every projection and cache that derives from a re-keyed row. */
  rekeyed(): void;
}

/**
 * Repository settings: one row per repository identity carrying its closeout,
 * validation, reviewer, QA, checks policy, scratch namespace and host kind, plus
 * the durable re-key receipts that move a row to a new identity.
 */
export class StoreRepositorySettings {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry, private readonly access: RepositorySettingsAccess) {}
  private get db() { return this.core.db; }

  repositoryByKey(key: string): RepositorySettings | null {
    const row = this.db.prepare("SELECT data FROM repository_settings WHERE key=?").get(key);
    return row ? repositorySettingsSchema.parse(JSON.parse(String(row.data))) : null;
  }

  repositories(): RepositorySettings[] {
    return this.db.prepare("SELECT data FROM repository_settings ORDER BY rowid").all().map(row => repositorySettingsSchema.parse(JSON.parse(String(row.data))));
  }

  /**
   * Spec 056: what a fresh re-key would do, read-only. It never applies later
   * drifted input: apply re-checks every one of these facts in its transaction.
   */
  previewRepositoryRekey(input: RepositoryRekeyPreviewInput): RepositoryRekeyPreview {
    return previewRekey(this.db, input, operationInputHash(input), now());
  }

  /**
   * Spec 056: one repository namespace re-key, one transaction, one durable
   * idempotent receipt. A lost reply reads the receipt written by this step;
   * repeating the same key with the same input returns it unchanged, and the
   * same key with different input refuses before any write.
   */
  rekeyRepository(input: RepositoryRekeyInput): RepositoryRekeyResult {
    const parsed = repositoryRekeyInputSchema.parse(input);
    const inputHash = operationInputHash(parsed);
    return this.core.transaction(() => {
      const existing = this.repositoryRekeyReceipt({ key: parsed.idempotencyKey });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("Repository re-key key already used with different input");
        return { receipt: existing, replayed: true };
      }
      const id = digest(`repository-rekey\n${parsed.idempotencyKey}`);
      const receipt = applyRekey(this.db, parsed, { id, key: parsed.idempotencyKey, inputHash, at: now() });
      this.db.prepare("INSERT INTO repository_rekeys(id,key,at,inputHash,data) VALUES(?,?,?,?,?)")
        .run(receipt.id, receipt.key, receipt.at, receipt.inputHash, JSON.stringify(receipt));
      // The re-key bypasses the write funnels, so every projection and cache that
      // derives from a re-keyed row is dropped rather than trusted.
      this.access.rekeyed();
      return { receipt, replayed: false };
    });
  }

  /** The durable receipt of one applied re-key, read by its caller key or by its id. */
  repositoryRekeyReceipt(query: RepositoryRekeyReceiptQuery): RepositoryRekeyReceipt | null {
    const row = "id" in query
      ? this.db.prepare("SELECT data FROM repository_rekeys WHERE id=?").get(query.id)
      : this.db.prepare("SELECT data FROM repository_rekeys WHERE key=?").get(query.key);
    return row ? repositoryRekeyReceiptSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /** Every applied re-key receipt, oldest first; operator evidence, never rewritten. */
  repositoryRekeys(): RepositoryRekeyReceipt[] {
    return this.db.prepare("SELECT data FROM repository_rekeys ORDER BY rowid").all()
      .map(row => repositoryRekeyReceiptSchema.parse(JSON.parse(String(row.data))));
  }

  /** Match a repository settings row by exact origin slug or exact local path, so a caller may name either. */
  repositoryFor(repository: string): RepositorySettings | null {
    return this.repositories().find(project => project.repository.origin === repository || (Boolean(project.repository.path) && project.repository.path === repository)) ?? null;
  }

  /** The row a patch or set by this identity reads before it writes: its own key first, then a path-only predecessor it re-keys. */
  repositorySettingsFor(identity: RepositorySettings["repository"]): RepositorySettings | null {
    return this.repositoryByKey(repositoryKey(identity))
      ?? (identity.origin && identity.path ? this.repositoryByKey(identity.path) : null);
  }

  /**
   * Fill a repository identity that arrived as an origin string. A provided path
   * is kept; an unrecognized origin falls back to that resolved path, as lead
   * and papercut writes did. With no path, the registered checkout is the one
   * `papercut.list` would resolve.
   */
  resolveRepositoryIdentity(input: { origin: string; path: string }): { origin: string; path: string } {
    const path = input.path.trim();
    if (path) return { origin: normalizeRepositoryOrigin(input.origin) ?? resolve(path), path };
    const origin = normalizeRepositoryOrigin(input.origin) ?? input.origin;
    const row = this.repositoryFor(origin);
    const hinted = (row?.repository.path ?? "").trim()
      || (this.registry.projects().flatMap(project => project.repositories).find(repo => repo.origin === origin)?.path ?? "").trim();
    if (!hinted) throw new Error(`No local checkout for ${origin}: pass {origin, path} or register the repository first`);
    return { origin: row?.repository.origin ?? origin, path: hinted };
  }

  /** Monotonic write ordinal for repository settings rows, allocated inside the caller's transaction: durable latest-setting order independent of clock resolution. */
  private nextRepositoryRevision(): number {
    const revision = (this.core.getMeta<number>("projectRevision") ?? 0) + 1;
    this.core.setMeta("projectRevision", revision);
    return revision;
  }

  putRepository(identity: RepositorySettings["repository"], closeout: ProjectCloseout | null, note: string, validation: ProjectValidation | null = null, reviewer: RepositorySettings["reviewer"] = null, qa: ProjectQa | null = null, checksPolicy: RepositorySettings["checksPolicy"] | undefined = undefined, scratchNamespace?: string | null, hostKind?: HostKind | null, affectedTests?: RepositorySettings["affectedTests"], workspaceProvider?: RepositorySettings["workspaceProvider"]): RepositorySettings {
    if (!identity.origin && !identity.path) throw new Error("A project needs a repository origin or local path");
    const write = () => {
      // A path hint set from a real checkout survives a later origin-only set.
      const existing = this.repositoryByKey(repositoryKey(identity));
      // An origin appearing after a path-only set re-keys that predecessor in the
      // loop below; its checks policy moves with the row rather than silently
      // reverting the repository to the blocking default.
      const pathOnlyPredecessor = identity.origin && identity.path ? this.repositoryByKey(identity.path) : null;
      const merged = existing && !identity.path && existing.repository.path ? { ...identity, path: existing.repository.path } : identity;
      // When an origin appears after a path-only set, the row re-keys: absorb the
      // path-keyed predecessor in the same transaction. A row that carries a known
      // origin is a different repository identity whenever its origin differs, so
      // a reused local path never absorbs — or deletes — another project's
      // permanent settings.
      for (const row of this.repositories()) {
        const rowKey = repositoryKey(row.repository);
        if (rowKey === repositoryKey(merged)) continue;
        if (row.repository.origin === null && merged.path && row.repository.path === merged.path)
          this.db.prepare("DELETE FROM repository_settings WHERE key=?").run(rowKey);
      }
      const parsed = repositorySettingsSchema.parse({ repository: merged, scratchNamespace: scratchNamespace === undefined ? existing?.scratchNamespace ?? pathOnlyPredecessor?.scratchNamespace ?? null : scratchNamespace, closeout, validation, reviewer, qa, affectedTests: affectedTests === undefined ? existing?.affectedTests ?? pathOnlyPredecessor?.affectedTests ?? null : affectedTests, checksPolicy: checksPolicy === undefined ? existing?.checksPolicy ?? pathOnlyPredecessor?.checksPolicy ?? null : checksPolicy, hostKind: hostKind !== undefined ? hostKind : existing?.hostKind ?? pathOnlyPredecessor?.hostKind ?? null, workspaceProvider: workspaceProvider !== undefined ? workspaceProvider : existing?.workspaceProvider ?? pathOnlyPredecessor?.workspaceProvider ?? null, note, updatedAt: now(), revision: this.nextRepositoryRevision() });
      this.db.prepare("INSERT INTO repository_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(repositoryKey(merged), JSON.stringify(parsed));
      this.registry.ensureProject(merged.path, merged.origin);
      this.core.advanceRevision();
      return parsed;
    };
    return this.db.isTransaction ? write() : this.core.transaction(write);
  }

  /** Patch semantics: only the named fields change; `null` clears one and an absent field keeps its stored value. Returns the full resulting row. */
  patchRepository(identity: RepositorySettings["repository"], patch: { scratchNamespace?: string | null; closeout?: ProjectCloseout | null; validation?: ProjectValidation | null; reviewer?: RepositorySettings["reviewer"]; qa?: ProjectQa | null; affectedTests?: RepositorySettings["affectedTests"]; checksPolicy?: RepositorySettings["checksPolicy"]; hostKind?: HostKind | null; workspaceProvider?: RepositorySettings["workspaceProvider"]; note?: string }): RepositorySettings {
    const apply = () => {
      const existing = this.repositorySettingsFor(identity);
      const base = existing ?? { closeout: null, validation: null, reviewer: null, qa: null, affectedTests: null, checksPolicy: null, note: "" };
      return this.putRepository(identity, patch.closeout !== undefined ? patch.closeout : base.closeout, patch.note !== undefined ? patch.note : base.note,
        patch.validation !== undefined ? patch.validation : base.validation, patch.reviewer !== undefined ? patch.reviewer : base.reviewer,
        patch.qa !== undefined ? patch.qa : base.qa,
        patch.checksPolicy !== undefined ? patch.checksPolicy : base.checksPolicy,
        patch.scratchNamespace, patch.hostKind, patch.affectedTests !== undefined ? patch.affectedTests : base.affectedTests,
        patch.workspaceProvider);
    };
    return this.db.isTransaction ? apply() : this.core.transaction(apply);
  }

  scratchNamespaceFor(task: Pick<Task, "repoPath" | "repository">): string {
    const row = this.canonicalRepository(task.repoPath, task.repository);
    return repositoryScratchNamespace(task.repository ?? task.repoPath, row?.scratchNamespace);
  }

  workspaceProviderFor(task: Pick<Task, "repoPath" | "repository">): WorkspaceProvider {
    return this.canonicalRepository(task.repoPath, task.repository)?.workspaceProvider ?? "local";
  }

  /** Task 382: the effective hosted-check policy for a task's repository. An absent or null setting keeps every check blocking, so existing repositories never gain advisory behaviour implicitly. */
  checksPolicyFor(task: Pick<Task, "repoPath" | "repository">): RepositoryChecksPolicy {
    return this.canonicalRepository(task.repoPath, task.repository)?.checksPolicy ?? DEFAULT_REPOSITORY_CHECKS_POLICY;
  }

  /** The canonical row a repository's settings resolve to: specificity first (origin identity over path hint), then the monotonic write revision — the same row closeout authority reads. */
  canonicalRepository(repoPath: string, origin?: string | null): RepositorySettings | null {
    const ranked = this.repositories()
      .map(project => ({ project, weight: repositoryMatchSpecificity(project, repoPath, origin) }))
      .filter(entry => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || b.project.revision - a.project.revision);
    return ranked[0]?.project ?? null;
  }

  /** Spec 022: the closeout override for a repository with no manifest, when a repository settings row sets it. */
  repositoryCloseoutOverride(repoPath: string, origin?: string | null): ProjectCloseout | null {
    return this.canonicalRepository(repoPath, origin)?.closeout ?? null;
  }
}
