/**
 * Sibling links declared by a repository's `nucleus worktree prepare`
 * setup call and its primary's Effigy dependency-link ledger. Project QA and
 * task checkouts share the literal-argument parser and the configured-checkout
 * source resolution. Hooks are never executed or evaluated here.
 *
 * Task checkouts are registered with Paseo as directory workspaces, which skip
 * `worktree.setup`, so Queue places only these links beside a new checkout
 * (links-only, Tom 2026-10-23). Placement creates when absent or reuses an
 * exact match; anything else is left untouched and recorded. No teardown.
 */
import { existsSync } from "node:fs";
import {
  lstat,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  Task,
  WorkspaceAllocation,
  WorktreeLink,
  WorktreeLinkFinding,
  WorktreeLinks,
} from "../../shared/contracts";
import { gitRaw } from "../hooks/hooks";
import { repositoryOrigin } from "../planning/lanes";
import {
  ownedWorkspaceRoot,
  repoCommonDir,
  WORKSPACES_DIR,
} from "./workspace-allocation";
import {
  assertCheckoutAvailable,
  liveCheckoutDataDir,
} from "./checkout-volume";
import { getWorkRoot } from "./work-root.mjs";
import { siblingNameFor, siblingPathFor } from "./siblings";

export interface WorktreeSiblingSpec {
  source: string;
  linkName: string | null;
}

/** A Queue-configured checkout: a registered repository or a project member. */
export interface ConfiguredCheckout {
  origin: string | null;
  path: string;
}

export const WORKTREE_LINKS_MANIFEST_MAX_BYTES = 256 * 1024;
export const WORKTREE_LINKS_LEDGER_MAX_BYTES = 256 * 1024;
const DETAIL_MAX = 2000;
/** The task record's bounds (shared/contracts.ts worktreeLinksSchema). */
const LINKS_MAX = 200,
  LINK_NAME_MAX = 256,
  LINK_TARGET_MAX = 1024;
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_MAX);

export async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRaw(cwd, args);
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  return result.stdout.toString("utf8").trim();
}

export function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Raw literal arguments of every `nucleus worktree prepare` call, stopping at a shell operator. */
export function worktreeSiblingTokens(setup: string | null): string[] {
  if (!setup) return [];
  const tokens: string[] = [];
  const prepare = /nucleus\s+worktree\s+prepare(?=\s|$)([^;&|]*)/g;
  for (const match of setup.matchAll(prepare))
    tokens.push(...(match[1] ?? "").trim().split(/\s+/).filter(Boolean));
  return tokens;
}

/** One literal `<src>[=<name>]` argument; a dynamic or absolute source or an unsafe name throws. */
export function worktreeSiblingSpec(
  rawToken: string,
  prefix = "Project QA",
): WorktreeSiblingSpec {
  const token = rawToken.replace(
    /^(?:"(.*)"|'(.*)')$/,
    (
      _whole,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => doubleQuoted ?? singleQuoted ?? "",
  );
  const separator = token.lastIndexOf("=");
  const source = separator < 0 ? token : token.slice(0, separator);
  const linkName = separator < 0 ? null : token.slice(separator + 1);
  if (!source || isAbsolute(source) || source.startsWith("$"))
    throw new Error(
      `${prefix} cannot prepare a dynamic or absolute declared worktree sibling source: ${token}`,
    );
  if (linkName !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(linkName))
    throw new Error(
      `${prefix} worktree sibling link name is not a safe path component: ${linkName}`,
    );
  return { source, linkName };
}

/** Read literal source arguments declared by the Nucleus worktree command; the first refusal throws. */
export function worktreeSiblingSpecs(
  setup: string | null,
  prefix = "Project QA",
): WorktreeSiblingSpec[] {
  return worktreeSiblingTokens(setup).map((token) =>
    worktreeSiblingSpec(token, prefix),
  );
}

/**
 * Resolve one sibling source the way the repository's own
 * `nucleus worktree prepare` does: relative paths against the primary checkout
 * root, then canonicalise through a Queue-configured checkout so Queue never
 * links an arbitrary path.
 */
export async function resolveSiblingSource(
  primaryRoot: string,
  rawSource: string,
  configured: readonly ConfiguredCheckout[],
  prefix = "Project QA",
): Promise<string> {
  const requested = isAbsolute(rawSource)
    ? rawSource
    : resolve(primaryRoot, rawSource);
  const source = await realpath(requested).catch(() => null);
  if (!source)
    throw new Error(
      `${prefix} worktree sibling source is unavailable: ${rawSource}`,
    );
  await configuredSourceRoot(source, configured, prefix);
  return source;
}

/** Resolve a declared local source to a Queue-configured primary checkout, never a linked/task worktree. */
export async function configuredSourceRoot(
  sourcePath: string,
  configuredCheckouts: readonly ConfiguredCheckout[],
  prefix = "Project QA",
): Promise<{ root: string; relativePath: string }> {
  const source = await realpath(sourcePath).catch(() => null);
  if (!source)
    throw new Error(
      `${prefix} worktree sibling source is unavailable: ${sourcePath}`,
    );
  const sourceGitRoot = await realpath(
    await gitText(source, "rev-parse", "--show-toplevel"),
  );
  const sourceOrigin = await repositoryOrigin(sourceGitRoot).catch(() => null);
  const configured = configuredCheckouts.filter(
    (repo) => repo.path && existsSync(repo.path),
  );
  const candidates = new Map<string, { origin: string | null; path: string }>();
  for (const repo of configured) {
    const path = await realpath(repo.path).catch(() => null);
    if (path) candidates.set(path, { origin: repo.origin, path });
  }
  let configuredRoot: string | null = null;
  for (const candidate of candidates.values()) {
    let candidateRoot: string | null;
    try {
      candidateRoot = await realpath(
        await gitText(candidate.path, "rev-parse", "--show-toplevel"),
      );
    } catch {
      continue;
    }
    if (!candidateRoot) continue;
    if (candidateRoot === sourceGitRoot) {
      configuredRoot = candidateRoot;
      break;
    }
    const candidateOrigin =
      candidate.origin ??
      (await repositoryOrigin(candidateRoot).catch(() => null));
    if (sourceOrigin && candidateOrigin === sourceOrigin)
      configuredRoot ??= candidateRoot;
  }
  if (!configuredRoot)
    throw new Error(
      `${prefix} worktree sibling source is not a configured Queue repository: ${source}`,
    );
  const dotGit = await lstat(join(configuredRoot, ".git")).catch(() => null);
  if (!dotGit?.isDirectory())
    throw new Error(
      `${prefix} will not use a linked worktree as a sibling source: ${configuredRoot}`,
    );
  const relativePath = relative(configuredRoot, source);
  if (!isWithin(configuredRoot, source))
    throw new Error(
      `${prefix} worktree sibling source is outside its configured checkout: ${source}`,
    );
  return { root: configuredRoot, relativePath };
}

/**
 * The literal Effigy dependency-link sources recorded in the registered
 * checkout, in the order the repository's own helper reads them. Paths are
 * kept as written: the helper resolves a relative path against the primary
 * checkout root, exactly as Queue does when it prepares the link.
 */
export async function dependencyLinkPaths(
  repositoryPath: string,
  maxBytes?: number,
): Promise<string[]> {
  const sourcePath = join(
    repositoryPath,
    ".effigy/local/dependency-links.json",
  );
  let source: string;
  try {
    if (maxBytes !== undefined && (await stat(sourcePath)).size > maxBytes)
      throw new Error(
        `Effigy dependency-link ledger exceeds ${maxBytes} bytes`,
      );
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ledger = JSON.parse(source) as {
    schema?: unknown;
    schema_version?: unknown;
    links?: unknown;
  };
  if (
    ledger.schema !== "effigy.deps.links.v1" ||
    ledger.schema_version !== 1 ||
    !Array.isArray(ledger.links)
  )
    throw new Error(
      "Registered checkout has an invalid Effigy dependency-link ledger",
    );
  const paths: string[] = [];
  for (const rawLink of ledger.links) {
    if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink))
      throw new Error(
        "Effigy dependency-link ledger contains a malformed link",
      );
    const link = rawLink as { key?: unknown };
    if (!link.key || typeof link.key !== "object" || Array.isArray(link.key))
      throw new Error("Effigy dependency-link ledger contains a malformed key");
    const key = link.key as Record<string, unknown>;
    if (typeof key.library_path !== "string" || key.library_path === "")
      throw new Error(
        "Effigy dependency-link ledger has an invalid library path",
      );
    paths.push(key.library_path);
  }
  return paths;
}

const TASK_PREFIX = "Task worktree link";

/**
 * The `worktree` block of a parsed `paseo.json`, validated once: the manifest is
 * an object and its `worktree` block is an object (an absent block is empty).
 * Each consumer reads the keys it understands from the same block.
 */
export function worktreeManifestBlock(source: string): Record<string, unknown> {
  const manifest = JSON.parse(source) as { worktree?: unknown };
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    throw new Error("paseo.json must be an object");
  if (manifest.worktree === undefined) return {};
  if (
    !manifest.worktree ||
    typeof manifest.worktree !== "object" ||
    Array.isArray(manifest.worktree)
  )
    throw new Error("paseo.json worktree must be an object");
  return manifest.worktree as Record<string, unknown>;
}

/** `worktree.setup` as a list of strings; a string or an array of strings is accepted. */
export function worktreeSetupScripts(source: string): string[] {
  const setup = worktreeManifestBlock(source).setup;
  if (setup === undefined) return [];
  if (typeof setup === "string") return [setup];
  if (Array.isArray(setup) && setup.every((item) => typeof item === "string"))
    return setup as string[];
  throw new Error(
    "paseo.json worktree.setup must be a string or an array of strings",
  );
}

export interface DeclaredWorktreeLinks {
  commit: string | null;
  candidates: { name: string; target: string }[];
  findings: WorktreeLinkFinding[];
}

/**
 * The links a task checkout declares at its exact HEAD: literal `prepare`
 * arguments from that commit's `paseo.json`, then the primary's live Effigy
 * ledger. Every problem is a finding for that item, never a throw. A name with
 * two different targets is a conflict for that name, not an ordered choice.
 */
export async function declaredWorktreeLinks(input: {
  directory: string;
  primaryRoot: string;
  configured: readonly ConfiguredCheckout[];
}): Promise<DeclaredWorktreeLinks> {
  const findings: WorktreeLinkFinding[] = [];
  const add = (
    kind: WorktreeLinkFinding["kind"],
    name: string | null,
    detail: string,
  ) =>
    findings.push({
      kind,
      name: name === null ? null : name.slice(0, LINK_NAME_MAX),
      detail: detail.slice(0, DETAIL_MAX) || kind,
    });
  const wanted: { name: string; target: string }[] = [];
  let commit: string | null = null;
  try {
    commit = await gitText(
      input.directory,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    );
  } catch (error) {
    add(
      "manifest_invalid",
      null,
      `Task checkout HEAD is unreadable: ${message(error)}`,
    );
  }
  if (commit) {
    const object = `${commit}:paseo.json`;
    const present = await gitRaw(input.directory, [
      "cat-file",
      "-e",
      object,
    ]).catch(() => null);
    if (present?.code === 0) {
      try {
        const size = Number(
          await gitText(input.directory, "cat-file", "-s", object),
        );
        if (!Number.isFinite(size) || size > WORKTREE_LINKS_MANIFEST_MAX_BYTES)
          throw new Error(
            `paseo.json at ${commit} exceeds ${WORKTREE_LINKS_MANIFEST_MAX_BYTES} bytes`,
          );
        const shown = await gitRaw(input.directory, ["show", object]);
        if (shown.code !== 0)
          throw new Error(`Could not read paseo.json at ${commit}`);
        const setupScripts = worktreeSetupScripts(
          shown.stdout.toString("utf8"),
        );
        for (const script of setupScripts) {
          if (/paseo:worktree\s+--\s+prepare(?=\s|$)/.test(script))
            add(
              "argument_unsupported",
              null,
              "paseo:worktree prepare is retired; use nucleus worktree prepare",
            );
        }
        for (const token of setupScripts.flatMap(worktreeSiblingTokens)) {
          let spec: WorktreeSiblingSpec;
          try {
            spec = worktreeSiblingSpec(token, TASK_PREFIX);
          } catch (error) {
            add("argument_unsupported", null, message(error));
            continue;
          }
          try {
            const target = await resolveSiblingSource(
              input.primaryRoot,
              spec.source,
              input.configured,
              TASK_PREFIX,
            );
            wanted.push({ name: spec.linkName ?? basename(target), target });
          } catch (error) {
            add(
              "source_unresolved",
              spec.linkName ?? basename(spec.source),
              message(error),
            );
          }
        }
      } catch (error) {
        add(
          "manifest_invalid",
          null,
          `paseo.json at ${commit}: ${message(error)}`,
        );
      }
    }
  }
  try {
    for (const libraryPath of await dependencyLinkPaths(
      input.primaryRoot,
      WORKTREE_LINKS_LEDGER_MAX_BYTES,
    )) {
      try {
        const target = await resolveSiblingSource(
          input.primaryRoot,
          libraryPath,
          input.configured,
          TASK_PREFIX,
        );
        wanted.push({ name: basename(target), target });
      } catch (error) {
        add("source_unresolved", basename(libraryPath), message(error));
      }
    }
  } catch (error) {
    add("ledger_invalid", null, message(error));
  }
  const byName = new Map<string, Set<string>>();
  for (const link of wanted)
    byName.set(
      link.name,
      (byName.get(link.name) ?? new Set()).add(link.target),
    );
  const candidates: { name: string; target: string }[] = [];
  for (const [name, targets] of byName) {
    if (targets.size === 1) candidates.push({ name, target: [...targets][0]! });
    else
      add(
        "name_conflict",
        name,
        `${name} is declared with different targets: ${[...targets].join(", ")}; no link placed`,
      );
  }
  return { commit, candidates, findings };
}

/**
 * The canonical Queue allocation parent of this task checkout, re-proved now:
 * the workspaces dir and the repository's owned root are real directories
 * (never links), and the checkout's parent resolves to exactly that root.
 */
export async function canonicalLinkRoot(
  dataDir: string,
  repoPath: string,
  directory: string,
  testPlacement?: {
    dataDir: string;
    retainedDataDirs?: string[];
    admit: (path: string) => void;
  },
  bargeAllocation?: WorkspaceAllocation | null,
): Promise<string> {
  if (bargeAllocation?.provider === "barge") {
    if (
      bargeAllocation.state === "returned" ||
      !bargeAllocation.leaseId ||
      !bargeAllocation.checkoutPath ||
      !bargeAllocation.gitCommonDir
    ) {
      throw new Error(
        "Barge workspace link root requires an active Barge allocation",
      );
    }
    const [actualDir, expectedDir, actualCommon, expectedCommon] =
      await Promise.all([
        realpath(directory),
        realpath(bargeAllocation.checkoutPath),
        repoCommonDir(directory),
        realpath(bargeAllocation.gitCommonDir),
      ]);
    if (actualDir !== expectedDir || actualCommon !== expectedCommon) {
      throw new Error(
        "Barge checkout path or Git common directory does not match the recorded lease",
      );
    }
    return dirname(actualDir);
  }
  let data = await realpath(dataDir);
  const awaitableCommon = await repoCommonDir(repoPath);
  const live = liveCheckoutDataDir(dataDir);
  const roots = testPlacement
    ? [testPlacement.dataDir, ...(testPlacement.retainedDataDirs ?? [])]
    : live
      ? [join(getWorkRoot(), "queue")]
      : [];
  const checkoutName = basename(directory);
  const taskParent = checkoutName.startsWith("ns-")
    ? `task-${checkoutName.slice(3)}`
    : "";
  const linkRoot = (root: string) => {
    const base = ownedWorkspaceRoot(root, awaitableCommon);
    return taskParent && dirname(directory) === join(base, taskParent)
      ? join(base, taskParent)
      : base;
  };
  const builds = roots.find((root) => dirname(directory) === linkRoot(root));
  if (builds) {
    if (testPlacement) testPlacement.admit(directory);
    else assertCheckoutAvailable({ target: directory });
    data = await realpath(builds);
  }
  const base = ownedWorkspaceRoot(data, await repoCommonDir(repoPath));
  const expected =
    taskParent && dirname(directory) === join(base, taskParent)
      ? join(base, taskParent)
      : base;
  for (const component of [
    join(data, WORKSPACES_DIR),
    base,
    expected,
    dirname(directory),
  ]) {
    const entry = await lstat(component);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`${component} is redirected or is not a real directory`);
  }
  if ((await realpath(dirname(directory))) !== expected)
    throw new Error(
      `${dirname(directory)} is not the canonical Queue allocation root ${expected} for this repository`,
    );
  return expected;
}

/** Observe an existing path: an exact link to `target` is reused, anything else is a conflict left untouched. */
async function observeLink(
  path: string,
  target: string,
): Promise<Pick<WorktreeLink, "outcome" | "reason">> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    return {
      outcome: "failed",
      reason: `could not inspect ${path}: ${message(error)}`,
    };
  }
  if (!entry.isSymbolicLink())
    return {
      outcome: "conflict",
      reason: `${path} exists and is not a symlink; left untouched`,
    };
  const points = await readlink(path).catch(() => "unreadable");
  const resolved = await realpath(path).catch(() => null);
  if (!resolved)
    return {
      outcome: "conflict",
      reason: `${path} is a dangling or unreadable link to ${points}; left untouched`,
    };
  if (resolved === target) return { outcome: "reused" };
  return {
    outcome: "conflict",
    reason: `${path} links to ${resolved}, not ${target}; left untouched`,
  };
}

/** Create `<root>/<name>` → `target` when absent, or reuse an exact match. Never replaces or deletes. */
export async function placeWorktreeLink(
  root: string,
  name: string,
  target: string,
  beforeCreate?: () => Promise<void>,
): Promise<WorktreeLink> {
  const path = join(root, name);
  const existing = await lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : error),
  );
  if (existing instanceof Error)
    return {
      name,
      target,
      outcome: "failed",
      reason: `could not inspect ${path}: ${message(existing)}`,
    };
  if (existing) return { name, target, ...(await observeLink(path, target)) };
  try {
    // Tests only: act between the absence observation and the create.
    await beforeCreate?.();
    await symlink(target, path);
    return { name, target, outcome: "created" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { name, target, ...(await observeLink(path, target)) };
    return {
      name,
      target,
      outcome: "failed",
      reason: `could not create ${path}: ${message(error)}`,
    };
  }
}

/**
 * One links-only pass for a new task checkout. Never throws: every problem is
 * a link outcome or a finding. Placement creates only when absent and reuses
 * only an exact match, so a pass re-run after a crash observes `reused`.
 */
export async function provisionWorktreeLinks(input: {
  dataDir: string;
  task: Pick<Task, "repoPath" | "directory" | "workspaceId"> & {
    workspaceAllocation?: Task["workspaceAllocation"];
  };
  configured: readonly ConfiguredCheckout[];
  pinned?: {
    taskId: string;
    pins: Task["siblingPins"];
    required: readonly ConfiguredCheckout[];
  };
  observeOnly?: boolean;
}): Promise<Omit<Extract<WorktreeLinks, { state: "prepared" }>, "at">> {
  const directory = input.task.directory!,
    workspaceId = input.task.workspaceId!;
  const declared = await declaredWorktreeLinks({
    directory,
    primaryRoot: input.task.repoPath,
    configured: input.configured,
  }).catch((error) => ({
    commit: null,
    candidates: [],
    findings: [
      {
        kind: "manifest_invalid" as const,
        name: null,
        detail: message(error) || "unreadable",
      },
    ],
  }));
  const base = {
    state: "prepared" as const,
    workspaceId,
    directory,
    commit: declared.commit,
  };
  const findings = [...declared.findings];
  // The record's own bounds: an oversized declaration is one finding, never a partial pick.
  const fits = (link: { name: string; target: string }) =>
    link.name.length <= LINK_NAME_MAX && link.target.length <= LINK_TARGET_MAX;
  for (const link of declared.candidates.filter((link) => !fits(link)))
    findings.push({
      kind: "argument_unsupported",
      name: link.name.slice(0, LINK_NAME_MAX),
      detail:
        `link name or target exceeds the record bound; no link placed`.slice(
          0,
          DETAIL_MAX,
        ),
    });
  let candidates = declared.candidates.filter(fits);
  if (input.pinned) {
    for (const repo of input.pinned.required) {
      const identity = repo.origin || repo.path;
      const pin = input.pinned.pins.find(
        (item) => item.repository === identity,
      );
      const name = pin ? basename(pin.path) : siblingNameFor(repo);
      const target = await realpath(repo.path).catch(() => null);
      if (!target) {
        findings.push({
          kind: "source_unresolved",
          name,
          detail: `Sibling ${identity} source is unavailable`,
        });
        continue;
      }
      const existing = candidates.find((item) => item.name === name);
      if (existing && !isWithin(target, existing.target)) {
        candidates = candidates.filter((item) => item.name !== name);
        findings.push({
          kind: "name_conflict",
          name,
          detail: `Sibling ${name} has conflicting sources; no link placed`,
        });
      } else if (!existing) candidates.push({ name, target });
    }
  }
  for (const link of candidates.filter((link) => !fits(link)))
    findings.push({
      kind: "argument_unsupported",
      name: link.name.slice(0, LINK_NAME_MAX),
      detail: "link name or target exceeds the record bound; no link placed",
    });
  candidates = candidates.filter(fits);
  if (candidates.length > LINKS_MAX) {
    findings.push({
      kind: "argument_unsupported",
      name: null,
      detail: `${candidates.length} links declared, more than ${LINKS_MAX}; none placed`,
    });
    candidates = [];
  }
  const bounded = (list: WorktreeLinkFinding[]) =>
    list.length <= LINKS_MAX
      ? list
      : [
          ...list.slice(0, LINKS_MAX - 1),
          {
            kind: "manifest_invalid" as const,
            name: null,
            detail: `${list.length - LINKS_MAX + 1} further findings omitted`,
          },
        ];
  if (!candidates.length)
    return { ...base, links: [], findings: bounded(findings) };
  const links: WorktreeLink[] = [];
  for (const candidate of candidates) {
    let root: string;
    let target = candidate.target;
    try {
      // Re-proved for each link, at the moment of change.
      root = await canonicalLinkRoot(
        input.dataDir,
        input.task.repoPath,
        directory,
        undefined,
        input.task.workspaceAllocation,
      );
      const source = await configuredSourceRoot(
        candidate.target,
        input.configured,
        TASK_PREFIX,
      );
      if (input.pinned) {
        let row: ConfiguredCheckout | undefined;
        for (const repo of input.pinned.required) {
          if ((await realpath(repo.path).catch(() => null)) === source.root) {
            row = repo;
            break;
          }
        }
        // A pin is keyed by the identity its member was recorded under (origin, else
        // the recorded path, as `siblingIdentity` and the BB wait key it), never by the
        // realpath, which differs when the project entry reaches the checkout by a symlink.
        const identity = row ? row.origin || row.path : source.root;
        const pin = input.pinned.pins.find(
          (item) => item.repository === identity,
        );
        if (row && !pin)
          throw new Error(
            `Sibling ${row.origin || source.root} copy is missing`,
          );
        if (pin) {
          const expected = siblingPathFor(
            input.dataDir,
            input.pinned.taskId,
            basename(pin.path),
          );
          const entry = await lstat(pin.path).catch(() => null);
          if (
            pin.path !== expected ||
            !entry?.isDirectory() ||
            entry.isSymbolicLink()
          )
            throw new Error(
              `Sibling ${pin.repository} copy is missing or outside its task root`,
            );
          if (
            (await gitText(
              pin.path,
              "rev-parse",
              "--verify",
              "HEAD^{commit}",
            )) !== pin.commit ||
            (await gitText(
              pin.path,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            )) !==
              (await gitText(
                source.root,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ))
          )
            throw new Error(
              `Sibling ${pin.repository} copy no longer matches its pin`,
            );
          target = await realpath(join(pin.path, source.relativePath));
          if (!isWithin(await realpath(pin.path), target))
            throw new Error(
              `Sibling ${pin.repository} copy redirects outside its worktree`,
            );
        }
      }
    } catch (error) {
      links.push({
        ...candidate,
        outcome: "failed",
        reason: message(error) || "refused",
      });
      continue;
    }
    const placed = input.observeOnly
      ? {
          name: candidate.name,
          target,
          ...(await observeLink(join(root, candidate.name), target)),
        }
      : await placeWorktreeLink(root, candidate.name, target);
    links.push(
      placed.reason
        ? { ...placed, reason: placed.reason.slice(0, DETAIL_MAX) }
        : placed,
    );
  }
  return { ...base, links, findings: bounded(findings) };
}

/** Recheck BB's recorded links before admitting a reviewer; never replace a changed path. */
export async function bbWorktreeLinksWait(
  task: Pick<
    Task,
    | "hostId"
    | "directory"
    | "workspaceId"
    | "worktreeLinks"
    | "siblingPins"
    | "repoPath"
    | "id"
  >,
  configured?: readonly ConfiguredCheckout[],
  observation?: { dataDir: string; required: readonly ConfiguredCheckout[] },
): Promise<string | null> {
  if (!task.hostId?.startsWith("bb:")) return null;
  if (!task.directory || !task.workspaceId)
    return "BB sibling provisioning waits: this workspace has no prepared link record";
  const observed =
    observation && configured
      ? await provisionWorktreeLinks({
          dataDir: observation.dataDir,
          task,
          configured,
          observeOnly: true,
          pinned: {
            taskId: task.id,
            pins: task.siblingPins,
            required: [
              ...observation.required,
              ...configured.filter(
                (row) =>
                  task.siblingPins.some(
                    (pin) => pin.repository === (row.origin || row.path),
                  ) &&
                  !observation.required.some(
                    (required) =>
                      required.path === row.path &&
                      required.origin === row.origin,
                  ),
              ),
            ],
          },
        })
      : null;
  if (!observed && task.worktreeLinks?.state !== "prepared") {
    if (!task.siblingPins.length && configured) {
      const declared = await declaredWorktreeLinks({
        directory: task.directory,
        primaryRoot: task.repoPath,
        configured,
      });
      if (!declared.candidates.length && !declared.findings.length) return null;
    }
    return "BB sibling provisioning waits: this workspace has no prepared link record";
  }
  const record =
    observed ??
    (task.worktreeLinks as Extract<WorktreeLinks, { state: "prepared" }>);
  if (
    record.workspaceId !== task.workspaceId ||
    record.directory !== task.directory
  )
    return "BB sibling provisioning waits: the link record belongs to another workspace";
  const failure =
    record.findings[0]?.detail ??
    record.links.find(
      (link) => link.outcome === "failed" || link.outcome === "conflict",
    )?.reason;
  if (failure) return `BB sibling provisioning waits: ${failure}`;
  for (const pin of task.siblingPins) {
    const name = basename(pin.path);
    const link = record.links.find((item) => item.name === name);
    const root = await realpath(pin.path).catch(() => null);
    const parent = dirname(pin.path);
    const directoryEntry = await lstat(pin.path).catch(() => null);
    const parentEntry = await lstat(parent).catch(() => null);
    if (
      basename(parent) !== task.id ||
      basename(dirname(parent)) !== "siblings" ||
      !directoryEntry?.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      !parentEntry?.isDirectory() ||
      parentEntry.isSymbolicLink()
    )
      return `BB sibling provisioning waits: ${name} is not the task's recorded sibling copy`;
    const linkedTarget =
      link && (await realpath(link.target).catch(() => null));
    if (!root || !link || !linkedTarget || !isWithin(root, linkedTarget))
      return `BB sibling provisioning waits: ${name} has no link to its recorded copy`;
    if (
      (await gitText(pin.path, "rev-parse", "--verify", "HEAD^{commit}").catch(
        () => null,
      )) !== pin.commit
    )
      return `BB sibling provisioning waits: ${name} no longer matches its pinned commit`;
    if (configured) {
      const row = configured.find(
        (item) => (item.origin || item.path) === pin.repository,
      );
      const common = await gitText(
        pin.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ).catch(() => null);
      const expectedCommon =
        row &&
        (await gitText(
          row.path,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ).catch(() => null));
      if (!common || !expectedCommon || common !== expectedCommon)
        return `BB sibling provisioning waits: ${name} does not belong to its configured repository`;
    }
  }
  if (configured) {
    const declaration = await declaredWorktreeLinks({
      directory: task.directory,
      primaryRoot: task.repoPath,
      configured,
    });
    if (declaration.findings.length)
      return `BB sibling provisioning waits: ${declaration.findings[0]!.detail}`;
    for (const candidate of declaration.candidates) {
      const source = await configuredSourceRoot(
        candidate.target,
        configured,
        TASK_PREFIX,
      ).catch(() => null);
      if (!source)
        return `BB sibling provisioning waits: ${candidate.name} source is unavailable`;
      let pin: Task["siblingPins"][number] | undefined;
      for (const row of configured) {
        if ((await realpath(row.path).catch(() => null)) !== source.root)
          continue;
        pin = task.siblingPins.find(
          (item) => item.repository === (row.origin || row.path),
        );
        if (pin) break;
      }
      const expected = pin
        ? await realpath(join(pin.path, source.relativePath)).catch(() => null)
        : candidate.target;
      const recorded = record.links.find(
        (link) => link.name === candidate.name,
      );
      if (
        !expected ||
        !recorded ||
        (await realpath(recorded.target).catch(() => null)) !== expected
      )
        return `BB sibling provisioning waits: ${candidate.name} does not match this checkout's declaration`;
    }
  }
  for (const link of record.links) {
    const actual = await realpath(
      join(dirname(task.directory), link.name),
    ).catch(() => null);
    const expected = await realpath(link.target).catch(() => null);
    if (!actual || !expected || actual !== expected)
      return `BB sibling provisioning waits: ${link.name} copy or link is missing or changed`;
  }
  return null;
}

/** Whether this launch is the first worker of the checkout the pending record names. */
export function worktreeLinksDue(
  task: Pick<
    Task,
    | "worktreeLinks"
    | "workspaceId"
    | "directory"
    | "agentIntent"
    | "agentId"
    | "runId"
    | "retiredWorkers"
    | "continuesWorkspace"
  >,
): boolean {
  const record = task.worktreeLinks;
  return (
    record?.state === "pending" &&
    Boolean(task.workspaceId && task.directory) &&
    record.workspaceId === task.workspaceId &&
    record.directory === task.directory &&
    !task.agentIntent &&
    !task.agentId &&
    !task.runId &&
    !task.retiredWorkers.length &&
    !task.continuesWorkspace
  );
}

/**
 * The record change for a NEW dispatch intent that will create a checkout,
 * committed in that intent's own update. Re-entering an intent already
 * recorded (legacy or new) changes nothing, so a legacy intent never becomes
 * eligible; an earlier checkout's final record is carried, never dropped.
 */
export function worktreeLinksForIntent(
  task: Pick<Task, "worktreeLinks" | "workspaceId" | "workspaceIntent">,
): Pick<Task, "worktreeLinks"> | Record<string, never> {
  const record = task.worktreeLinks;
  if (
    task.workspaceId ||
    task.workspaceIntent ||
    record?.state === "eligible" ||
    record?.state === "pending" ||
    record?.state === "ineligible"
  )
    return {};
  return {
    worktreeLinks:
      record?.state === "prepared"
        ? { state: "eligible", previous: record }
        : { state: "eligible" },
  };
}

/**
 * The record change when a validation retry clears a recorded intent whose
 * creation is provably absent: an eligible attempt stays eligible, and an
 * intent recorded without eligibility (legacy) becomes ineligible, so the
 * next dispatch cannot arm it. A carried final record is kept.
 */
export function worktreeLinksForClearedIntent(
  task: Pick<Task, "worktreeLinks" | "workspaceIntent">,
): Pick<Task, "worktreeLinks"> | Record<string, never> {
  const record = task.worktreeLinks;
  if (
    !task.workspaceIntent ||
    record?.state === "eligible" ||
    record?.state === "ineligible"
  )
    return {};
  const previous = record?.state === "prepared" ? record : undefined;
  return {
    worktreeLinks: previous
      ? { state: "ineligible", previous }
      : { state: "ineligible" },
  };
}

/**
 * The record change for the attempt's workspace binding (`workspace_created`
 * or `workspace_recovered`), committed in that same update. Only an eligible
 * attempt is armed. A binding equal to a carried final record restores it, and
 * every other record (absent legacy, pending, final) is left as it is: a
 * re-observed creation never re-arms or replays placement.
 */
export function worktreeLinksForBinding(
  task: Pick<Task, "worktreeLinks">,
  binding: { workspaceId: string; directory: string },
): Pick<Task, "worktreeLinks"> | Record<string, never> {
  const record = task.worktreeLinks;
  if (record?.state !== "eligible") return {};
  if (
    record.previous &&
    record.previous.workspaceId === binding.workspaceId &&
    record.previous.directory === binding.directory
  )
    return { worktreeLinks: record.previous };
  return {
    worktreeLinks: {
      state: "pending",
      workspaceId: binding.workspaceId,
      directory: binding.directory,
    },
  };
}

/** The `worktree_links_prepared` event detail. */
export function worktreeLinksSummary(
  record: Extract<WorktreeLinks, { state: "prepared" }>,
): string {
  const parts = record.links.map((link) => `${link.name} ${link.outcome}`);
  if (record.findings.length)
    parts.push(
      `${record.findings.length} finding(s): ${record.findings.map((finding) => finding.detail).join("; ")}`,
    );
  return (parts.join("; ") || "none declared").slice(0, DETAIL_MAX);
}
