/**
 * The BB host-operation executor (Spec 062, phase 0).
 *
 * One operation is one bounded step over `bb.sdk`; the answer is a projection of
 * exactly the fields the service validates, never a raw SDK row. The executor owns
 * three rules the later phases depend on:
 *
 * - a workspace step creates no thread: `workspace.create` registers the project and
 *   mints Nucleus's own handle, and reports how many `threads.spawn` calls it made
 *   (always zero) instead of asking a reader to believe it;
 * - an archive is preceded by its own cascade read inside the executor, and an
 *   archive whose cascade names a thread the caller did not already accept is
 *   refused, with the thread left unarchived;
 * - every SDK call is counted, because "zero spawns" and "one archive" are evidence.
 *
 * This file imports nothing but Node builtins so the plugin package builds from its
 * own directory with no dependency tree.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** The operations this plugin executes. `test/bb-plugin-operations.test.ts` pins it to the shared list. */
export const HOST_OPERATIONS = [
  "identity.probe",
  "workspace.create",
  "workspace.inspect",
  "run.attach",
  "thread.observe",
  "thread.stop",
  "thread.cascade",
  "thread.archive",
  "thread.delete",
  "thread.inventory",
  "thread.read",
  "thread.metadata",
  "thread.title",
  "thread.send",
  "thread.reparent",
  "thread.interactions",
  "thread.interaction.respond",
  "thread.interaction.cancel",
  "thread.timeline",
  "provider.catalog",
  "environment.list",
  "terminal.create",
  "terminal.list",
  "terminal.close",
  "call.counters",
] as const;

export type HostOperationName = (typeof HOST_OPERATIONS)[number];

/** The two send modes the adapter chooses between (Spec 062, phase 4). */
export const HOST_SEND_MODES = ["queue", "steer"] as const;
export type HostSendMode = (typeof HOST_SEND_MODES)[number];

/** The decisions BB's approval interactions carry. */
export const BB_PERMISSION_DECISIONS = [
  "allow_once",
  "allow_for_session",
  "deny",
] as const;
export type BbPermissionDecision = (typeof BB_PERMISSION_DECISIONS)[number];

/**
 * The only codes this executor may answer with. Kept identical to the service's list by
 * `test/bb-plugin-protocol.test.ts`.
 */
export const HOST_OPERATION_ERROR_CODES = [
  "invalid_input",
  "refused",
  "unavailable",
  "internal",
] as const;

export type HostOperationErrorCode =
  (typeof HOST_OPERATION_ERROR_CODES)[number];

/**
 * The codes that prove nothing was written. `refused` is only ever raised before a
 * write (a policy answer such as a cascade that names a thread this task does not
 * own). A failure that can follow a committed call — a spawn whose environment id
 * did not arrive, a read that failed after an archive — must answer `unavailable`
 * or `internal`, because those are unknown delivery and are never resent.
 */
export const HOST_OPERATION_NON_DELIVERY_CODES = [
  "invalid_input",
  "refused",
] as const;

export class HostOperationError extends Error {
  constructor(
    readonly code: HostOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostOperationError";
  }
}

export interface TerminalScope {
  kind: "thread" | "environment" | "host_path";
  threadId?: string;
  environmentId?: string;
  hostId?: string;
  cwd?: string;
}

export interface ThreadRow {
  id: string;
  title?: string | null;
  status?: string;
  providerId?: string;
  environmentId?: string | null;
  parentThreadId?: string | null;
  parentNotifications?: string | null;
  pluginMetadata?: unknown;
  archivedAt?: number | null;
  originPluginId?: string | null;
  hasPendingInteraction?: boolean;
  queuedWork?: unknown;
  displayStatus?: string;
  runtime?: { displayStatus?: string };
  environmentPath?: string | null;
  updatedAt?: number;
  activity?: Record<string, number>;
  createdAt?: number;
}

export interface InteractionRow {
  id: string;
  threadId: string;
  status: string;
  payload?: {
    kind?: string;
    title?: string;
    availableDecisions?: string[];
    reason?: string | null;
    subject?: { kind?: string; presentation?: { title?: string } };
    questions?: Array<{
      id?: string;
      prompt?: string;
      shortLabel?: string;
      options?: Array<{ label?: string; value?: string; description?: string }>;
      multiSelect?: boolean;
      allowFreeText?: boolean;
      required?: boolean;
    }>;
  };
  resolution?: Record<string, unknown> | null;
}

export interface TerminalSessionRow {
  id: string;
  threadId?: string | null;
  environmentId?: string | null;
  hostId?: string | null;
  initialCwd?: string | null;
  status?: string;
  closeReason?: string | null;
}

export interface EnvironmentRow {
  id: string;
  path?: string | null;
  isWorktree?: boolean;
  status?: string;
  managed?: boolean;
}

export interface ProjectRow {
  id: string;
  sources?: Array<{ type?: string; path?: string }>;
}

/** The slice of `bb.sdk` this executor uses. The plugin binds the real SDK to it once. */
export interface BbHostSdk {
  system: { version(): Promise<{ currentVersion?: string | null }> };
  /** The BB server's own status (Spec 062, "Identity": the probe reads it). */
  status: {
    get(args?: { threadId?: string; projectId?: string }): Promise<unknown>;
  };
  hosts: { list(): Promise<Array<{ id: string; status?: string }>> };
  projects: {
    list(): Promise<ProjectRow[]>;
    create(args: {
      name: string;
      source: { type: "local_path"; hostId: string; path: string };
    }): Promise<ProjectRow>;
  };
  threads: {
    spawn(args: {
      projectId: string;
      providerId?: string;
      model?: string;
      reasoningLevel?: string;
      permissionMode?: string;
      sessionOptions?: Record<string, unknown>;
      title?: string;
      input?: Array<{ type: "text"; text: string }>;
      prompt?: string;
      environment: {
        type: "host";
        hostId: string;
        workspace: { type: "unmanaged"; path: string };
      };
      parentThreadId?: string;
      parentNotifications?: "auto" | "stuck" | "off";
      visibility?: "visible";
      origin?: "plugin";
      originPluginId?: string;
      pluginMetadata?: Record<string, unknown>;
    }): Promise<ThreadRow>;
    send?(args: {
      threadId: string;
      input: Array<{ type: "text"; text: string }>;
      mode: "queue-if-active" | "steer";
      pluginSubmission: { pluginId: string; data: { messageId: string } };
    }): Promise<{ ok: true; delivery: "sent" | "queued" }>;
    update?(args: {
      threadId: string;
      title?: string;
      parentThreadId?: string | null;
    }): Promise<unknown>;
    interactions: {
      list(args: { threadId: string }): Promise<InteractionRow[]>;
      get(args: {
        threadId: string;
        interactionId: string;
      }): Promise<InteractionRow>;
      resolve(args: {
        threadId: string;
        interactionId: string;
        resolution: Record<string, unknown>;
      }): Promise<InteractionRow>;
      cancel(args: {
        threadId: string;
        interactionId: string;
      }): Promise<InteractionRow>;
    };
    timeline?(args: {
      threadId: string;
      segmentLimit: string;
      includeNestedRows: "true";
      deferContent: "true";
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      maxSeq: number;
      timelinePage: { historySnapshot: string; olderCursor: unknown | null };
      activeBackgroundCommands: unknown[];
      activeWorkflows: unknown[];
    }>;
    defaultExecutionOptions?(args: { threadId: string }): Promise<{
      model: string;
      permissionMode: string;
      reasoningLevel: string;
    } | null>;
    get(args: { threadId: string }): Promise<ThreadRow>;
    stop(args: { threadId: string }): Promise<unknown>;
    archive(args: { threadId: string }): Promise<unknown>;
    delete?(args: {
      threadId: string;
      childThreadsConfirmed: boolean;
    }): Promise<{ ok: true }>;
    list(args: {
      originPluginId?: string;
      projectId?: string;
      includeHidden?: boolean;
      archived?: boolean;
      limit?: number;
      offset?: number;
      threadIds?: readonly string[];
    }): Promise<ThreadRow[]>;
    experimental_listCascade(args: {
      threadIds: string[];
      action: "archive" | "delete";
    }): Promise<{
      threads?: Array<{ threadId: string; cascadeThreadIds?: string[] }>;
    }>;
    experimental_listPluginMetadata(args: {
      pluginId: string;
      threadIds: string[];
    }): Promise<{ threads?: Array<{ threadId: string; metadata?: unknown }> }>;
  };
  providers?: {
    list(): Promise<
      Array<{
        id: string;
        available: boolean;
        capabilities: { permissionModes: string[] };
      }>
    >;
    models(args: { providerId: string; preferCached?: boolean }): Promise<{
      models: Array<{
        model: string;
        supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
      }>;
    }>;
  };
  environments: { list(): Promise<EnvironmentRow[]> };
  terminals: {
    create(args: {
      cols: number;
      rows: number;
      scope: TerminalScope;
      start?: { mode: "shell" };
      title: string;
    }): Promise<TerminalSessionRow>;
    list(args: {
      scope: TerminalScope;
    }): Promise<{ sessions?: TerminalSessionRow[] }>;
    close(args: {
      terminalId: string;
      mode: "force" | "if-clean";
    }): Promise<TerminalSessionRow>;
  };
}

export interface HostOperationsOptions {
  sdk: BbHostSdk;
  /** The BB plugin id this executor acts as; spawns carry it as their plugin origin. */
  pluginId: string;
  /** The plugin SDK version this build was written against, a diagnostic only. */
  sdkVersion: string;
  /** The BB server's data directory, read lazily by `identity.probe`. */
  dataDir: () => string;
  now?: () => number;
  /** How long an attach waits for BB to record the environment (tests shorten it). */
  attachWaitMs?: number;
}

/** The workspace handle shape decision 2 mints, derived exactly as the service derives it. */
export function workspaceHandleForPath(directory: string): string {
  let real = directory.replace(/\/+$/, "") || "/";
  try {
    real = realpathSync(directory);
  } catch {
    /* a path that does not exist still names its own handle */
  }
  return `bb-worktree-${createHash("sha256").update(real).digest("hex").slice(0, 40)}`;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new HostOperationError(
      "invalid_input",
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max);
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new HostOperationError(
      "invalid_input",
      `${field} must be one of ${values.join(", ")}`,
    );
  return value as T;
}

function terminalScope(value: unknown): TerminalScope {
  if (typeof value !== "object" || value === null)
    throw new HostOperationError("invalid_input", "scope must be an object");
  const scope = value as Record<string, unknown>;
  const kind = scope.kind;
  if (kind === "thread")
    return { kind, threadId: text(scope.threadId, "scope.threadId", 128) };
  if (kind === "environment")
    return {
      kind,
      environmentId: text(scope.environmentId, "scope.environmentId", 128),
    };
  if (kind === "host_path") {
    const hostId = text(scope.hostId, "scope.hostId", 128);
    // The list query reads `cwd` as a filter, not a default: an absent cwd must stay
    // absent, because a null would filter for terminals whose cwd is null.
    return typeof scope.cwd === "string"
      ? { kind, hostId, cwd: scope.cwd }
      : { kind, hostId };
  }
  throw new HostOperationError(
    "invalid_input",
    "scope.kind must be thread, environment or host_path",
  );
}

function projectMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HostOperationError(
      "invalid_input",
      "pluginMetadata must be an object",
    );
  return value as Record<string, unknown>;
}

function metadataOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)
    : null;
}

function threadProjection(row: ThreadRow) {
  // No manufactured status or flags: a changed SDK row must fail this request.
  if (
    ![
      "id",
      "title",
      "status",
      "providerId",
      "environmentId",
      "environmentPath",
      "parentThreadId",
      "parentNotifications",
      "originPluginId",
      "archivedAt",
      "updatedAt",
      "queuedWork",
      "runtime",
      "hasPendingInteraction",
    ].every((key) => Object.hasOwn(row, key)) ||
    !row.runtime ||
    typeof row.hasPendingInteraction !== "boolean" ||
    typeof row.updatedAt !== "number" ||
    typeof row.queuedWork !== "string" ||
    !Object.hasOwn(row, "environmentPath")
  )
    throw new HostOperationError(
      "unavailable",
      "threads.list row is missing runtime, interaction, activity or environment fields",
    );
  return {
    threadId: row.id,
    title: row.title ?? null,
    status: row.status,
    providerId: row.providerId,
    displayStatus: row.runtime.displayStatus,
    environmentId: row.environmentId ?? null,
    environmentPath: row.environmentPath,
    parentThreadId: row.parentThreadId ?? null,
    parentNotifications: row.parentNotifications,
    originPluginId: row.originPluginId ?? null,
    archivedAt: row.archivedAt ?? null,
    updatedAt: row.updatedAt,
    queuedWork: row.queuedWork,
    hasPendingInteraction: row.hasPendingInteraction,
  };
}

function terminalProjection(row: TerminalSessionRow) {
  return {
    id: row.id,
    threadId: row.threadId ?? null,
    environmentId: row.environmentId ?? null,
    hostId: row.hostId ?? null,
    initialCwd: row.initialCwd ?? null,
    status: row.status ?? "unknown",
    closeReason: row.closeReason ?? null,
  };
}

/** How long one attach waits for BB to record the environment it is provisioning. */
const ATTACH_WAIT_MS = 15_000;
const ATTACH_POLL_MS = 200;

export interface HostOperations {
  execute(
    op: HostOperationName,
    input: unknown,
  ): Promise<{
    operation: HostOperationName;
    at: string;
    calls: Record<string, number>;
    value: unknown;
  }>;
  counters(): { counters: Record<string, number>; loadedAt: number };
  consumeOwnParentChange(
    threadId: string,
    parentThreadId: string | null,
  ): boolean;
}

export function createHostOperations(
  options: HostOperationsOptions,
): HostOperations {
  const { sdk, pluginId, sdkVersion } = options;
  const now = options.now ?? Date.now;
  const loadedAt = now();
  const counters: Record<string, number> = {};
  let spawnCalls = 0;
  const ownParentChanges = new Map<string, number>();
  const parentChangeKey = (threadId: string, parentThreadId: string | null) =>
    `${threadId}\0${parentThreadId ?? ""}`;
  const expectOwnParentChange = (
    threadId: string,
    parentThreadId: string | null,
  ) =>
    ownParentChanges.set(
      parentChangeKey(threadId, parentThreadId),
      now() + 10_000,
    );

  async function call<T>(name: string, run: () => Promise<T>): Promise<T> {
    counters[name] = (counters[name] ?? 0) + 1;
    return await run();
  }

  async function primaryHostId(): Promise<string> {
    const hosts = await call("hosts.list", () => sdk.hosts.list());
    const host =
      hosts.find(
        (candidate) =>
          candidate.status === undefined || candidate.status === "connected",
      ) ?? hosts[0];
    if (!host)
      throw new HostOperationError(
        "unavailable",
        "This BB server reports no host to run the work on",
      );
    return host.id;
  }

  async function cascadeFor(
    threadId: string,
    action: "archive" | "delete" = "archive",
  ): Promise<string[]> {
    const read = await call("threads.experimental_listCascade", () =>
      sdk.threads.experimental_listCascade({ threadIds: [threadId], action }),
    );
    const row = (read?.threads ?? []).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!row)
      throw new HostOperationError(
        "unavailable",
        `The cascade read did not answer for ${threadId}, so no ${action} can be proven`,
      );
    if (!Array.isArray(row.cascadeThreadIds))
      throw new HostOperationError(
        "unavailable",
        `The cascade read omitted cascadeThreadIds; no ${action} can be proven`,
      );
    return row.cascadeThreadIds;
  }

  /**
   * A thread's plugin metadata is its own read, not a row field: `threads.get` never
   * carries it. A thread with none answers null rather than failing the observation.
   */
  async function threadMetadata(
    threadId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const read = await call("threads.experimental_listPluginMetadata", () =>
        sdk.threads.experimental_listPluginMetadata({
          pluginId,
          threadIds: [threadId],
        }),
      );
      const row = (read?.threads ?? []).find(
        (candidate) => candidate.threadId === threadId,
      );
      return metadataOf(row);
    } catch {
      return null;
    }
  }

  /**
   * Read exact thread IDs across both live and archived partitions (Spec 062, fact 16):
   * BB's `threads.list` requires `archived: true` to return archived rows, so omitting
   * it would mistake an archived thread for absent. Both partitions must answer arrays.
   */
  async function listExactThreads(threadIds: string[]): Promise<ThreadRow[]> {
    const live = await call("threads.list", () =>
      sdk.threads.list({
        threadIds,
        includeHidden: true,
        archived: false,
        limit: 200,
      }),
    );
    if (!Array.isArray(live))
      throw new HostOperationError(
        "unavailable",
        "threads.list did not answer an array for live threads",
      );
    const archived = await call("threads.list", () =>
      sdk.threads.list({
        threadIds,
        includeHidden: true,
        archived: true,
        limit: 200,
      }),
    );
    if (!Array.isArray(archived))
      throw new HostOperationError(
        "unavailable",
        "threads.list did not answer an array for archived threads",
      );
    const merged = new Map<string, ThreadRow>();
    for (const row of [...live, ...archived]) {
      if (
        row &&
        typeof row.id === "string" &&
        threadIds.includes(row.id) &&
        !merged.has(row.id)
      )
        merged.set(row.id, row);
    }
    return [...merged.values()];
  }

  async function observedRows(rows: ThreadRow[]) {
    const answer = [];
    for (const row of rows) {
      const projection = threadProjection(row);
      const interactions = row.hasPendingInteraction
        ? await call("threads.interactions.list", () =>
            sdk.threads.interactions.list({ threadId: row.id }),
          )
        : [];
      if (
        !Array.isArray(interactions) ||
        interactions.length > 200 ||
        interactions.some((i) => i.threadId !== row.id)
      )
        throw new HostOperationError(
          "unavailable",
          "interactions.list did not answer a bounded thread-scoped list",
        );
      answer.push({
        ...projection,
        interactions: interactions.map((i) => ({
          id: i.id,
          kind: i.payload?.kind ?? "unknown",
          status: i.status,
          title: Object.hasOwn(i.payload ?? {}, "title")
            ? (i.payload?.title ?? null)
            : null,
        })),
      });
    }
    return answer;
  }

  /**
   * One interaction as the pinned SDK declares it. A known kind missing a field the
   * SDK requires is `unavailable` (unknown, never a partial row); an unrecognised
   * extension kind is projected by what the SDK does promise: its kind and title.
   */
  function interactionProjection(row: InteractionRow, threadId: string) {
    if (row.threadId !== threadId)
      throw new HostOperationError(
        "unavailable",
        `interactions.list named thread ${row.threadId} for ${threadId}`,
      );
    const status = row.status;
    if (!["pending", "resolving", "resolved", "interrupted"].includes(status))
      throw new HostOperationError(
        "unavailable",
        `interaction ${row.id} carries an unrecognised status`,
      );
    const payload = row.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.kind !== "string"
    )
      throw new HostOperationError(
        "unavailable",
        `interaction ${row.id} carries no payload kind`,
      );
    const base = { interactionId: row.id, kind: payload.kind, status } as {
      interactionId: string;
      kind: string;
      status: string;
      title: string | null;
      questions?: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; value: string }>;
        allowFreeText: boolean;
      }>;
      decisions?: BbPermissionDecision[];
    };
    if (payload.kind === "approval") {
      const decisions = payload.availableDecisions;
      if (
        !Array.isArray(decisions) ||
        !decisions.length ||
        decisions.some(
          (decision) =>
            !(BB_PERMISSION_DECISIONS as readonly string[]).includes(decision),
        )
      )
        throw new HostOperationError(
          "unavailable",
          `approval ${row.id} carries no recognised decision set`,
        );
      const subject = payload.subject;
      // Only a subject kind that declares a presentation carries one; reading it on a
      // plan subject would invent a field the row does not have.
      const presentation =
        subject && Object.hasOwn(subject, "presentation")
          ? subject.presentation
          : undefined;
      const title = presentation?.title;
      return {
        ...base,
        title:
          typeof title === "string"
            ? title
            : typeof subject?.kind === "string"
              ? subject.kind
              : null,
        decisions: decisions as BbPermissionDecision[],
      };
    }
    if (payload.kind === "user_question") {
      const questions = payload.questions;
      if (
        !Array.isArray(questions) ||
        !questions.length ||
        questions.length > 32
      )
        throw new HostOperationError(
          "unavailable",
          `question ${row.id} carries no bounded question list`,
        );
      return {
        ...base,
        title: null,
        questions: questions.map((question) => {
          if (
            typeof question.id !== "string" ||
            !question.id ||
            typeof question.prompt !== "string" ||
            !question.prompt
          )
            throw new HostOperationError(
              "unavailable",
              `question ${row.id} is missing its id or prompt`,
            );
          if (
            question.options !== undefined &&
            !Array.isArray(question.options)
          )
            throw new HostOperationError(
              "unavailable",
              `question ${row.id} carries unreadable options`,
            );
          if (typeof question.allowFreeText !== "boolean")
            throw new HostOperationError(
              "unavailable",
              `question ${row.id} does not declare whether free text is allowed`,
            );
          const options = (question.options ?? []).map((option) => {
            // The label is what an operator reads; the value is what the provider accepts
            // back. They differ on real provider rows, so both are kept.
            if (typeof option?.label !== "string" || !option.label)
              throw new HostOperationError(
                "unavailable",
                `question ${row.id} carries an option without a label`,
              );
            if (typeof option.value !== "string" || !option.value)
              throw new HostOperationError(
                "unavailable",
                `question ${row.id} carries an option without a value`,
              );
            return { label: option.label, value: option.value };
          });
          return {
            id: question.id,
            header:
              typeof question.shortLabel === "string" && question.shortLabel
                ? question.shortLabel
                : question.id,
            question: question.prompt,
            options,
            allowFreeText: question.allowFreeText,
          };
        }),
      };
    }
    return {
      ...base,
      title: typeof payload.title === "string" ? payload.title : null,
    };
  }

  /** One interaction read that proves the thread and the request before any answer. */
  async function interactionFor(threadId: string, interactionId: string) {
    const row = await call("threads.interactions.get", () =>
      sdk.threads.interactions.get({ threadId, interactionId }),
    );
    if (typeof row !== "object" || row === null)
      throw new HostOperationError(
        "unavailable",
        `interaction ${interactionId} could not be read`,
      );
    if (row.id !== interactionId)
      throw new HostOperationError(
        "unavailable",
        `interaction read answered ${row.id} for ${interactionId}`,
      );
    return row;
  }

  /** The SDK's resolution union, built from the host contract's own answer shape. */
  function resolutionFor(
    row: InteractionRow,
    answer:
      | { kind: "question"; answers: Record<string, string> }
      | { kind: "permission"; decision: string },
    projection: {
      questions?: Array<{
        id: string;
        header: string;
        options: Array<{ label: string; value: string }>;
        allowFreeText: boolean;
      }>;
      decisions?: BbPermissionDecision[];
    },
  ) {
    if (answer.kind === "question") {
      if (!projection.questions)
        throw new HostOperationError(
          "refused",
          `interaction ${row.id} is not a native question`,
        );
      const answers: Record<string, { selected: string[]; freeText?: string }> =
        {};
      for (const [key, value] of Object.entries(answer.answers)) {
        const matches = projection.questions.filter(
          (question) => question.id === key || question.header === key,
        );
        if (matches.length !== 1)
          throw new HostOperationError(
            "refused",
            `answer key ${key} names no single question on interaction ${row.id}`,
          );
        const question = matches[0];
        if (answers[question.id])
          throw new HostOperationError(
            "refused",
            `answer key ${key} repeats question ${question.id}`,
          );
        if (!value.trim())
          throw new HostOperationError(
            "refused",
            `answer for ${question.id} is empty`,
          );
        // An offered choice is answered by its wire value, whether the caller named it
        // by label or by value; free text is only sent where the provider allows it.
        const offered =
          question.options.find((option) => option.value === value) ??
          question.options.find((option) => option.label === value);
        if (offered) answers[question.id] = { selected: [offered.value] };
        else if (question.allowFreeText)
          answers[question.id] = { selected: [], freeText: value };
        else
          throw new HostOperationError(
            "refused",
            `answer for ${question.id} is not one of the offered choices and free text is not allowed`,
          );
      }
      if (!Object.keys(answers).length)
        throw new HostOperationError(
          "refused",
          "a native question answer names no question",
        );
      return { kind: "user_answer" as const, answers };
    }
    if (!projection.decisions)
      throw new HostOperationError(
        "refused",
        `interaction ${row.id} is not a permission request`,
      );
    // The host contract has five decisions and BB three; a decision BB cannot express
    // is refused before the write rather than widened into another permission.
    const decision: BbPermissionDecision | undefined =
      answer.decision === "accept"
        ? "allow_once"
        : answer.decision === "acceptForSession"
          ? "allow_for_session"
          : answer.decision === "decline" || answer.decision === "cancel"
            ? "deny"
            : undefined;
    if (!decision)
      throw new HostOperationError(
        "refused",
        `BB has no ${answer.decision} permission decision`,
      );
    if (!projection.decisions.includes(decision))
      throw new HostOperationError(
        "refused",
        `interaction ${row.id} does not offer ${decision}`,
      );
    return decision === "deny"
      ? { decision }
      : { decision, grantedPermissions: null };
  }

  async function resolveInteraction(
    threadId: string,
    interactionId: string,
    answer:
      | { kind: "question"; answers: Record<string, string> }
      | { kind: "permission"; decision: string },
  ) {
    // Bind the exact thread and request before anything is written.
    const row = await interactionFor(threadId, interactionId);
    const projection = interactionProjection(row, threadId);
    if (projection.status !== "pending" && projection.status !== "resolving")
      throw new HostOperationError(
        "refused",
        `interaction ${interactionId} is no longer pending`,
      );
    const resolution = resolutionFor(row, answer, projection);
    const resolved = await call("threads.interactions.resolve", () =>
      sdk.threads.interactions.resolve({ threadId, interactionId, resolution }),
    );
    if (
      typeof resolved !== "object" ||
      resolved === null ||
      resolved.id !== interactionId ||
      resolved.threadId !== threadId
    )
      throw new HostOperationError(
        "unavailable",
        `interaction ${interactionId} did not answer for its own thread`,
      );
    if (resolved.status !== "resolved" && resolved.status !== "resolving")
      throw new HostOperationError(
        "unavailable",
        `interaction ${interactionId} answered status ${resolved.status} after the answer`,
      );
    return {
      threadId,
      interactionId,
      status: resolved.status,
      resolutionKind:
        resolution.kind ?? ("decision" in resolution ? "decision" : "unknown"),
    };
  }

  async function execute(
    op: HostOperationName,
    raw: unknown,
  ): Promise<unknown> {
    const input = (
      typeof raw === "object" && raw !== null ? raw : {}
    ) as Record<string, unknown>;
    switch (op) {
      case "identity.probe": {
        // The read-only identity probe: the three reads Spec 062 names — the server's
        // own status, its version and one bounded thread list — plus the host list the
        // projection reports. Every one of them is a read; none of them writes.
        const status = await call("status.get", () => sdk.status.get({}));
        if (typeof status !== "object" || status === null)
          throw new HostOperationError(
            "unavailable",
            "status.get answered no status for this BB server",
          );
        const version = await call("system.version", () =>
          sdk.system.version(),
        );
        const threads = await call("threads.list", () =>
          sdk.threads.list({ limit: 1 }),
        );
        if (!Array.isArray(threads))
          throw new HostOperationError(
            "unavailable",
            "threads.list answered no rows for this BB server",
          );
        const hosts = await call("hosts.list", () => sdk.hosts.list());
        return {
          dataDir: options.dataDir(),
          bbVersion: String(version.currentVersion ?? "unknown"),
          sdkVersion,
          hostIds: hosts.map((host) => host.id),
        };
      }
      case "workspace.create": {
        const repositoryRoot = text(
          input.repositoryRoot,
          "repositoryRoot",
          4_096,
        );
        const workspacePath =
          input.workspacePath === undefined
            ? repositoryRoot
            : text(input.workspacePath, "workspacePath", 4_096);
        const name = text(input.name, "name", 120);
        const spawnsBefore = spawnCalls;
        const hostId = await primaryHostId();
        const projects = await call("projects.list", () => sdk.projects.list());
        const existing = projects.find((project) =>
          (project.sources ?? []).some(
            (source) =>
              source.type === "local_path" &&
              typeof source.path === "string" &&
              samePath(source.path, repositoryRoot),
          ),
        );
        let projectId: string;
        let projectCreated = false;
        if (existing) projectId = existing.id;
        else {
          const created = await call("projects.create", () =>
            sdk.projects.create({
              name,
              source: { type: "local_path", hostId, path: repositoryRoot },
            }),
          );
          projectId = created.id;
          projectCreated = true;
        }
        return {
          projectId,
          projectCreated,
          projectCount: projectCreated ? projects.length + 1 : projects.length,
          handle: workspaceHandleForPath(workspacePath),
          path: workspacePath,
          // The whole point of the step: no thread exists before a run does.
          spawned: spawnCalls - spawnsBefore,
        };
      }
      case "workspace.inspect": {
        const repositoryRoot = text(
          input.repositoryRoot,
          "repositoryRoot",
          4_096,
        );
        const requestedProjectId = optionalText(
          input.projectId,
          "projectId",
          128,
        );
        const projects = await call("projects.list", () => sdk.projects.list());
        const project = projects.find(
          (candidate) =>
            (!requestedProjectId || candidate.id === requestedProjectId) &&
            (candidate.sources ?? []).some(
              (source) =>
                source.type === "local_path" &&
                typeof source.path === "string" &&
                samePath(source.path, repositoryRoot),
            ),
        );
        return {
          projectId: project?.id ?? null,
          projectFound: Boolean(project),
          path: project ? repositoryRoot : null,
        };
      }
      case "run.attach": {
        const projectId = text(input.projectId, "projectId", 128);
        const title = text(input.title, "title", 200);
        const environmentPath = text(
          input.environmentPath,
          "environmentPath",
          4_096,
        );
        const prompt =
          input.prompt === undefined
            ? undefined
            : text(input.prompt, "prompt", 500_000);
        const parentThreadId = optionalText(
          input.parentThreadId,
          "parentThreadId",
          128,
        );
        const parentNotifications =
          oneOf(
            input.parentNotifications,
            ["auto", "stuck", "off"] as const,
            "parentNotifications",
          ) ?? "off";
        const providerId = optionalText(input.providerId, "providerId", 64);
        const model = optionalText(input.model, "model", 200);
        const pluginMetadata = projectMetadata(input.pluginMetadata);
        const hostId = await primaryHostId();
        const spawnsBefore = spawnCalls;
        const thread = await call("threads.spawn", () =>
          sdk.threads.spawn({
            projectId,
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
            title,
            ...(input.reasoningLevel
              ? {
                  reasoningLevel: text(
                    input.reasoningLevel,
                    "reasoningLevel",
                    32,
                  ),
                }
              : {}),
            ...(input.permissionMode
              ? {
                  permissionMode: text(
                    input.permissionMode,
                    "permissionMode",
                    32,
                  ),
                }
              : {}),
            ...(input.sessionOptions
              ? { sessionOptions: projectMetadata(input.sessionOptions) }
              : {}),
            ...(prompt === undefined
              ? {}
              : { input: [{ type: "text" as const, text: prompt }] }),
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path: environmentPath },
            },
            ...(parentThreadId ? { parentThreadId } : {}),
            parentNotifications,
            visibility: "visible",
            origin: "plugin",
            originPluginId: pluginId,
            ...(pluginMetadata ? { pluginMetadata } : {}),
          }),
        );
        spawnCalls += 1;
        // `threads.spawn` returns when the row is committed, not when the worktree is
        // attached: a fresh unmanaged path is provisioned after the row lands. The run
        // does not count as created until the environment id is recorded, so wait for
        // that bounded window rather than reporting a half-attached run.
        let row = thread;
        const deadline = now() + (options.attachWaitMs ?? ATTACH_WAIT_MS);
        while (!row.environmentId && now() < deadline) {
          await sleep(ATTACH_POLL_MS);
          try {
            row = await call("threads.get", () =>
              sdk.threads.get({ threadId: thread.id }),
            );
          } catch (error) {
            if (error instanceof HostOperationError) throw error;
            throw new HostOperationError(
              "unavailable",
              `threads.get failed while waiting for the environment: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (!row.environmentId) {
          // The thread exists; only the environment is late. That is unknown
          // delivery, never a refusal: resending the spawn would duplicate it.
          throw new HostOperationError(
            "unavailable",
            `BB committed thread ${thread.id} but did not record an environment within ${options.attachWaitMs ?? ATTACH_WAIT_MS} ms; the spawn landed and is not retryable, adopt thread ${thread.id}`,
          );
        }
        if (
          typeof row.createdAt !== "number" ||
          !Object.hasOwn(row, "parentThreadId") ||
          typeof row.parentNotifications !== "string"
        )
          throw new HostOperationError(
            "unavailable",
            "run.attach returned no creation stamp or parent fields; the committed spawn must be adopted",
          );
        return {
          threadId: row.id,
          environmentId: row.environmentId,
          status: row.status,
          parentThreadId: row.parentThreadId,
          parentNotifications: row.parentNotifications,
          pluginMetadata: await threadMetadata(row.id),
          createdAt: row.createdAt,
          spawned: spawnCalls - spawnsBefore,
        };
      }
      case "thread.observe": {
        const threadId = text(input.threadId, "threadId", 128);
        const rows = await listExactThreads([threadId]);
        if (rows.length !== 1 || rows[0].id !== threadId)
          throw new HostOperationError(
            "unavailable",
            "threads.list omitted the requested thread",
          );
        const observed = (await observedRows(rows))[0];
        const execution = await call("threads.defaultExecutionOptions", () =>
          sdk.threads.defaultExecutionOptions!({ threadId }),
        );
        return {
          ...observed,
          pluginMetadata: await threadMetadata(threadId),
          execution:
            execution === null
              ? null
              : {
                  model: execution.model,
                  permissionMode: execution.permissionMode,
                  reasoningLevel: execution.reasoningLevel,
                },
        };
      }
      case "thread.read": {
        const threadIds = input.threadIds as string[];
        if (
          !Array.isArray(threadIds) ||
          !threadIds.length ||
          threadIds.length > 200
        )
          throw new HostOperationError(
            "invalid_input",
            "threadIds must name 1 to 200 threads",
          );
        const rows = await listExactThreads(threadIds);
        return { rows: await observedRows(rows) };
      }
      case "thread.metadata": {
        const threadIds = input.threadIds as string[];
        if (
          !Array.isArray(threadIds) ||
          !threadIds.length ||
          threadIds.length > 200
        )
          throw new HostOperationError(
            "invalid_input",
            "threadIds must name 1 to 200 threads",
          );
        const read = await call("threads.experimental_listPluginMetadata", () =>
          sdk.threads.experimental_listPluginMetadata({ pluginId, threadIds }),
        );
        if (!Array.isArray(read?.threads))
          throw new HostOperationError(
            "unavailable",
            "plugin metadata list is unreadable",
          );
        return {
          threads: read.threads.map((row) => ({
            threadId: row.threadId,
            metadata: metadataOf(row),
          })),
        };
      }
      case "thread.timeline": {
        const threadId = text(input.threadId, "threadId", 128);
        const page = await call("threads.timeline", () =>
          sdk.threads.timeline!({
            threadId,
            segmentLimit: "20",
            includeNestedRows: "true",
            deferContent: "true",
          }),
        );
        if (
          !Array.isArray(page.rows) ||
          !Number.isSafeInteger(page.maxSeq) ||
          page.maxSeq < 0 ||
          !page.timelinePage ||
          typeof page.timelinePage.historySnapshot !== "string" ||
          !page.timelinePage.historySnapshot ||
          !Object.hasOwn(page.timelinePage, "olderCursor") ||
          !Array.isArray(page.activeBackgroundCommands) ||
          !Array.isArray(page.activeWorkflows)
        )
          throw new HostOperationError(
            "unavailable",
            "threads.timeline omitted its window or background-work evidence",
          );
        const entries: Array<{
          id: string;
          seq: number;
          at: number;
          turnId: string | null;
          status: string;
          name: string;
        }> = [];
        let visited = 0;
        function visit(rows: Array<Record<string, unknown>>, depth: number) {
          if (depth > 8)
            throw new HostOperationError(
              "unavailable",
              "threads.timeline nesting exceeded its bound",
            );
          for (const row of rows) {
            if (++visited > 2000 || row.threadId !== threadId)
              throw new HostOperationError(
                "unavailable",
                "threads.timeline exceeded its row bound or named another thread",
              );
            if (row.kind === "turn") {
              if (!Array.isArray(row.children))
                throw new HostOperationError(
                  "unavailable",
                  "threads.timeline turn children are unreadable",
                );
              visit(row.children, depth + 1);
            } else if (row.kind === "work") {
              if (
                typeof row.id !== "string" ||
                !Number.isSafeInteger(row.sourceSeqStart) ||
                (row.sourceSeqStart as number) < 0 ||
                (row.sourceSeqStart as number) > page.maxSeq ||
                typeof row.startedAt !== "number" ||
                typeof row.workKind !== "string" ||
                !["pending", "completed", "error", "interrupted"].includes(
                  String(row.status),
                )
              )
                throw new HostOperationError(
                  "unavailable",
                  "threads.timeline work row is missing its identity, sequence or status",
                );
              entries.push({
                id: row.id,
                seq: row.sourceSeqStart as number,
                at: row.startedAt,
                turnId: typeof row.turnId === "string" ? row.turnId : null,
                status: String(row.status),
                name: row.workKind,
              });
            } else if (row.kind !== "conversation" && row.kind !== "system") {
              throw new HostOperationError(
                "unavailable",
                "threads.timeline returned an unrecognised row kind",
              );
            }
          }
        }
        visit(page.rows, 0);
        entries.sort((a, b) => a.seq - b.seq);
        const rows = await call("threads.list", () =>
          sdk.threads.list({
            threadIds: [threadId],
            includeHidden: true,
            limit: 200,
          }),
        );
        const activity =
          rows.length === 1 && rows[0].id === threadId
            ? rows[0].activity
            : null;
        const kinds = [
          "activeWorkflowCount",
          "activeBackgroundAgentCount",
          "activeBackgroundCommandCount",
          "activePlanModeCount",
        ];
        if (
          !activity ||
          kinds.some(
            (kind) =>
              !Number.isSafeInteger(activity[kind]) || activity[kind] < 0,
          )
        )
          throw new HostOperationError(
            "unavailable",
            "threads.list omitted background activity counts",
          );
        const labels: Record<string, string> = {
          activeWorkflowCount: "workflows",
          activeBackgroundAgentCount: "background agents",
          activeBackgroundCommandCount: "background commands",
          activePlanModeCount: "active plans",
        };
        const pendingBackgroundTasks = kinds
          .filter((kind) => activity[kind] > 0)
          .map((kind) => `${labels[kind]}: ${activity[kind]}`);
        if (page.activeBackgroundCommands.length)
          pendingBackgroundTasks.push(
            `background commands: ${page.activeBackgroundCommands.length}`,
          );
        if (page.activeWorkflows.length)
          pendingBackgroundTasks.push(
            `workflows: ${page.activeWorkflows.length}`,
          );
        return {
          threadId,
          entries,
          hasOlder: page.timelinePage.olderCursor !== null,
          pendingBackgroundTasks,
        };
      }
      case "thread.send": {
        const threadId = text(input.threadId, "threadId", 128),
          messageId = text(input.messageId, "messageId", 200);
        const message = text(input.text, "text", 500_000);
        const mode = oneOf(input.mode, HOST_SEND_MODES, "mode") ?? "queue";
        if (mode === "steer") {
          // The one proven-not-sent steer refusal: a read taken before the write
          // proves there is no live turn to steer, so nothing was delivered and the
          // adapter may answer with one queued send.
          const rows = await call("threads.list", () =>
            sdk.threads.list({
              threadIds: [threadId],
              includeHidden: true,
              limit: 200,
            }),
          );
          if (
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            rows[0].id !== threadId
          )
            throw new HostOperationError(
              "unavailable",
              "threads.list omitted the thread a steer names",
            );
          const row = threadProjection(rows[0]);
          const live = ["starting", "active", "stopping"].includes(
            String(row.status ?? ""),
          );
          if (!live)
            throw new HostOperationError(
              "refused",
              `BB thread ${threadId} has no live turn to steer`,
            );
        }
        const sent = await call("threads.send", () =>
          sdk.threads.send!({
            threadId,
            mode: mode === "steer" ? "steer" : "queue-if-active",
            input: [{ type: "text", text: message }],
            pluginSubmission: { pluginId, data: { messageId } },
          }),
        );
        if (sent.ok !== true)
          throw new HostOperationError(
            "unavailable",
            "threads.send did not acknowledge the message",
          );
        return { threadId, delivery: sent.delivery, mode };
      }
      case "thread.reparent": {
        const threadId = text(input.threadId, "threadId", 128);
        // nucleus#1313: null clears the parent link, which is how a group becomes
        // standalone; a named parent re-nests it. Either way the write's
        // postcondition is the parent link itself, read back.
        const parentThreadId =
          input.parentThreadId === null
            ? null
            : text(input.parentThreadId, "parentThreadId", 128);
        expectOwnParentChange(threadId, parentThreadId);
        // Keep the echo marker through an ambiguous failure too: BB may have
        // committed the parent update before the call lost its reply.
        await call("threads.update", () =>
          sdk.threads.update!({ threadId, parentThreadId }),
        );
        const row = await call("threads.get", () =>
          sdk.threads.get({ threadId }),
        );
        if ((row.parentThreadId ?? null) !== parentThreadId)
          throw new HostOperationError(
            "unavailable",
            "threads.update did not move the thread's parent link",
          );
        return { threadId, parentThreadId };
      }
      case "thread.interactions": {
        const threadId = text(input.threadId, "threadId", 128);
        const rows = await call("threads.interactions.list", () =>
          sdk.threads.interactions.list({ threadId }),
        );
        if (!Array.isArray(rows) || rows.length > 200)
          throw new HostOperationError(
            "unavailable",
            "interactions.list did not answer a bounded list",
          );
        return {
          threadId,
          interactions: rows.map((row) => interactionProjection(row, threadId)),
        };
      }
      case "thread.interaction.respond": {
        const threadId = text(input.threadId, "threadId", 128),
          interactionId = text(input.interactionId, "interactionId", 128);
        const answer = (
          typeof input.answer === "object" && input.answer !== null
            ? input.answer
            : {}
        ) as { kind?: unknown; answers?: unknown; decision?: unknown };
        if (answer.kind === "question") {
          if (
            typeof answer.answers !== "object" ||
            answer.answers === null ||
            Array.isArray(answer.answers)
          )
            throw new HostOperationError(
              "invalid_input",
              "answer.answers must be an object",
            );
          const answers: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            answer.answers as Record<string, unknown>,
          ))
            answers[key] = text(value, `answer.answers.${key}`, 2_000);
          return await resolveInteraction(threadId, interactionId, {
            kind: "question",
            answers,
          });
        }
        if (answer.kind === "permission")
          return await resolveInteraction(threadId, interactionId, {
            kind: "permission",
            decision: text(answer.decision, "answer.decision", 32),
          });
        throw new HostOperationError(
          "invalid_input",
          "answer.kind must be question or permission",
        );
      }
      case "thread.interaction.cancel": {
        const threadId = text(input.threadId, "threadId", 128),
          interactionId = text(input.interactionId, "interactionId", 128);
        // Bind the exact thread and request, and dismiss only a native question.
        const row = await interactionFor(threadId, interactionId);
        const projection = interactionProjection(row, threadId);
        if (projection.kind !== "user_question")
          throw new HostOperationError(
            "refused",
            `interaction ${interactionId} is not a native question`,
          );
        if (
          projection.status !== "pending" &&
          projection.status !== "resolving"
        )
          throw new HostOperationError(
            "refused",
            `interaction ${interactionId} is no longer pending`,
          );
        const cancelled = await call("threads.interactions.cancel", () =>
          sdk.threads.interactions.cancel({ threadId, interactionId }),
        );
        if (
          typeof cancelled !== "object" ||
          cancelled === null ||
          cancelled.id !== interactionId ||
          cancelled.threadId !== threadId
        )
          throw new HostOperationError(
            "unavailable",
            `interaction ${interactionId} did not cancel for its own thread`,
          );
        if (
          cancelled.status !== "interrupted" &&
          cancelled.status !== "resolved" &&
          cancelled.status !== "resolving"
        )
          throw new HostOperationError(
            "unavailable",
            `interaction ${interactionId} answered status ${cancelled.status} after dismissal`,
          );
        return { threadId, interactionId, status: cancelled.status };
      }
      case "thread.title": {
        const threadId = text(input.threadId, "threadId", 128),
          title = text(input.title, "title", 200);
        await call("threads.update", () =>
          sdk.threads.update!({ threadId, title }),
        );
        const row = await call("threads.get", () =>
          sdk.threads.get({ threadId }),
        );
        return { threadId, title: row.title ?? null };
      }
      case "provider.catalog": {
        if (!sdk.providers)
          throw new HostOperationError(
            "unavailable",
            "providers API is unavailable",
          );
        const providers = await call("providers.list", () =>
          sdk.providers!.list(),
        );
        const answer = [];
        for (const provider of providers.filter((p) => p.available)) {
          const result = await call("providers.models", () =>
            sdk.providers!.models({
              providerId: provider.id,
              preferCached: true,
            }),
          );
          answer.push({
            id: provider.id,
            modes: provider.capabilities.permissionModes,
            models: result.models.map((m) => ({
              id: m.model,
              reasoningLevels: m.supportedReasoningEfforts.map(
                (r) => r.reasoningEffort,
              ),
            })),
          });
        }
        return { providers: answer };
      }
      case "thread.stop": {
        const threadId = text(input.threadId, "threadId", 128);
        await call("threads.stop", () => sdk.threads.stop({ threadId }));
        const row = await call("threads.get", () =>
          sdk.threads.get({ threadId }),
        );
        return {
          threadId,
          status: row.status ?? "unknown",
          displayStatus: row.runtime?.displayStatus ?? row.status ?? "unknown",
        };
      }
      case "thread.cascade": {
        const threadId = text(input.threadId, "threadId", 128);
        const action = oneOf(
          input.action,
          ["archive", "delete"] as const,
          "action",
        );
        if (!action)
          throw new HostOperationError(
            "invalid_input",
            'action must be "archive" or "delete"',
          );
        const cascadeThreadIds = await cascadeFor(threadId, action);
        return { threadId, action, cascadeThreadIds };
      }
      case "thread.archive": {
        const threadId = text(input.threadId, "threadId", 128);
        const expected = Array.isArray(input.expectedCascadeThreadIds)
          ? input.expectedCascadeThreadIds.map((value) =>
              text(value, "expectedCascadeThreadIds[]", 128),
            )
          : null;
        if (!expected)
          throw new HostOperationError(
            "invalid_input",
            "expectedCascadeThreadIds must be an array",
          );
        const cascadeThreadIds = await cascadeFor(threadId, "archive");
        const unaccepted = cascadeThreadIds.filter(
          (id) => !expected.includes(id),
        );
        if (unaccepted.length > 0)
          throw new HostOperationError(
            "refused",
            `Archive refused: the cascade for ${threadId} would also archive ${unaccepted.join(", ")}, which this task does not own`,
          );
        await call("threads.archive", () => sdk.threads.archive({ threadId }));
        const row = await call("threads.get", () =>
          sdk.threads.get({ threadId }),
        );
        if (typeof row.archivedAt !== "number")
          throw new HostOperationError(
            "unavailable",
            "Archive has not been observed on the thread",
          );
        return { threadId, archivedAt: row.archivedAt, cascadeThreadIds };
      }
      case "thread.delete": {
        const threadId = text(input.threadId, "threadId", 128);
        const expected = Array.isArray(input.expectedCascadeThreadIds)
          ? input.expectedCascadeThreadIds.map((value) =>
              text(value, "expectedCascadeThreadIds[]", 128),
            )
          : null;
        if (!expected)
          throw new HostOperationError(
            "invalid_input",
            "expectedCascadeThreadIds must be an array",
          );
        if (!sdk.threads.delete)
          throw new HostOperationError(
            "unavailable",
            "threads.delete API is unavailable",
          );
        const cascadeThreadIds = await cascadeFor(threadId, "delete");
        const unaccepted = cascadeThreadIds.filter(
          (id) => !expected.includes(id),
        );
        if (unaccepted.length > 0)
          throw new HostOperationError(
            "refused",
            `Delete refused: the cascade for ${threadId} would also delete ${unaccepted.join(", ")}, which this task does not own`,
          );
        const deleted = await call("threads.delete", () =>
          sdk.threads.delete!({
            threadId,
            childThreadsConfirmed: cascadeThreadIds.some(
              (id) => id !== threadId,
            ),
          }),
        );
        if (deleted?.ok !== true)
          throw new HostOperationError(
            "unavailable",
            "threads.delete did not confirm thread removal",
          );
        const remaining = await listExactThreads([threadId]);
        if (remaining.some((row) => row.id === threadId))
          throw new HostOperationError(
            "unavailable",
            "Delete has not been observed on the thread",
          );
        return { threadId, deleted: true as const, cascadeThreadIds };
      }
      case "thread.inventory": {
        const originPluginId = optionalText(
          input.originPluginId,
          "originPluginId",
          128,
        );
        const projectId = optionalText(input.projectId, "projectId", 128);
        const offset =
          typeof input.offset === "number" &&
          Number.isInteger(input.offset) &&
          input.offset >= 0
            ? input.offset
            : 0;
        const rows = await call("threads.list", () =>
          sdk.threads.list({
            ...(originPluginId ? { originPluginId } : {}),
            ...(projectId ? { projectId } : {}),
            includeHidden: input.includeHidden === true,
            archived: input.archived === true,
            limit: 200,
            offset,
          }),
        );
        if (!Array.isArray(rows) || rows.length > 200)
          throw new HostOperationError(
            "unavailable",
            "threads.list exceeded its page bound",
          );
        return { complete: rows.length < 200, rows: await observedRows(rows) };
      }
      case "environment.list": {
        const rows = await call("environments.list", () =>
          sdk.environments.list(),
        );
        return {
          environments: rows.map((row) => ({
            environmentId: row.id,
            path: row.path ?? "",
            isWorktree: row.isWorktree === true,
            status: row.status ?? "unknown",
            managed: row.managed === true,
          })),
        };
      }
      case "terminal.create": {
        const session = await call("terminals.create", () =>
          sdk.terminals.create({
            cols: typeof input.cols === "number" ? input.cols : 80,
            rows: typeof input.rows === "number" ? input.rows : 24,
            scope: terminalScope(input.scope),
            start: { mode: "shell" },
            title: text(input.title, "title", 200),
          }),
        );
        return { session: terminalProjection(session) };
      }
      case "terminal.list": {
        const listed = await call("terminals.list", () =>
          sdk.terminals.list({ scope: terminalScope(input.scope) }),
        );
        return { sessions: (listed.sessions ?? []).map(terminalProjection) };
      }
      case "terminal.close": {
        const mode =
          oneOf(input.mode, ["force", "if-clean"] as const, "mode") ?? "force";
        const session = await call("terminals.close", () =>
          sdk.terminals.close({
            terminalId: text(input.terminalId, "terminalId", 128),
            mode,
          }),
        );
        return { session: terminalProjection(session) };
      }
      case "call.counters":
        return { counters: { ...counters }, loadedAt };
      default:
        throw new HostOperationError(
          "invalid_input",
          `Unknown host operation ${String(op)}`,
        );
    }
  }

  return {
    consumeOwnParentChange(threadId, parentThreadId) {
      const key = parentChangeKey(threadId, parentThreadId);
      const until = ownParentChanges.get(key);
      if (until === undefined) return false;
      if (until < now()) {
        ownParentChanges.delete(key);
        return false;
      }
      ownParentChanges.delete(key);
      return true;
    },
    async execute(op, input) {
      if (!HOST_OPERATIONS.includes(op))
        throw new HostOperationError(
          "invalid_input",
          `Unknown host operation ${String(op)}`,
        );
      const value = await execute(op, input);
      return {
        operation: op,
        at: new Date(now()).toISOString(),
        calls: { ...counters },
        value,
      };
    },
    counters() {
      return { counters: { ...counters }, loadedAt };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return value.replace(/\/+$/, "");
    }
  };
  return canonical(left) === canonical(right);
}
