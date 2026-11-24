import {
  useInfiniteQuery,
  useQuery,
  type QueryClient,
  type QueryFilters,
} from "@tanstack/react-query";
import { z } from "zod";
import { prerequisiteSummary } from "../board/text";
import { readLiveFrames, type LiveFrame } from "./live-channel";

const api = "/api/engine";
const root = ["rust-board"];
const listKey = [...root, "list"];
const taskKey = (id: string) => [...root, "task", id];
const historyPageSize = 30;
const revision = z.number().int().nonnegative();
const timestamp = z.number().int();
const head = z.string().regex(/^[a-f0-9]{40}$/);
const role = z.enum(["worker", "reviewer"]);
const phase = z.enum([
  "queued",
  "working",
  "report_ready",
  "blocked",
  "error",
  "reviewing",
  "merging",
  "closing",
  "done",
  "cancelled",
]);
const repair = z.enum([
  "pull_request_unavailable",
  "workspace_head_mismatch",
  "revision_has_same_head",
  "merge_blocked",
  "merge_unconfirmed",
]);

const question = z.union([
  z.object({
    work: z.object({ prompt: z.string(), options: z.array(z.string()) }),
  }),
  z.object({ retry: z.object({ role }) }),
  z.object({ accept: z.object({ head }) }),
  z.object({ allowance: z.object({ used_ms: revision, limit_ms: revision }) }),
  z.object({ repair }),
]);
const dependencyFact = z.object({
  taskId: z.string(),
  // Empty for a redacted prerequisite in another scope.
  reference: z.string(),
  title: z.string().nullable(),
  phase: phase.nullable(),
  status: z.enum([
    "satisfied",
    "pending",
    "cancelled",
    "removed",
    "goal_unmet",
    "missing",
  ]),
});
const dependencyStatus = z.object({
  dependencies: z.array(dependencyFact),
  prerequisiteWait: z
    .object({
      reason: z.string(),
      releasedAtMs: timestamp.nullable(),
      prerequisites: z.array(dependencyFact),
    })
    .nullable(),
  blocking: z.boolean(),
});
const dependencyEdits = z.object({
  setDependencies: z.boolean(),
  setPrerequisiteWait: z.boolean(),
});
const current = z.object({
  version: revision,
  phase,
  wait: z.string().nullable(),
  nextCheckAt: timestamp.nullable(),
  question: question.nullable(),
  dependencyStatus,
});
const summary = current.extend({
  title: z.string().optional(),
  number: z.number().int().positive().nullish(),
  reference: z.string().optional(),
  identity: z.object({
    id: z.string(),
    reference: z.string(),
    repository: z.string(),
    base: z.string(),
  }),
  hold: z.object({ reason: z.string() }).nullable(),
});
const verdict = z.union([
  z.object({
    reviewed: z.object({
      head,
      decision: z.enum(["approve", "changes"]),
      summary: z.string(),
    }),
  }),
  z.object({
    accepted: z.object({ head, acceptance: z.object({ reason: z.string() }) }),
  }),
]);
const reportArtifact = z.object({
  key: z.string(),
  version: revision,
  digest: z.string(),
});
const allowance = z.object({
  usedMs: revision,
  limitMs: revision,
  exhausted: z.boolean(),
});
const detail = summary.extend({
  allowance: allowance.optional(),
  dependencyEdits,
  brief: z.object({ text: z.string(), version: revision }),
  pullRequest: z.object({ url: z.httpUrl(), head }).nullable(),
  verdict: verdict.nullable(),
  report: z.object({
    lane: z.string(),
    planningBase: head,
    failure: z.string().nullable(),
    delivery: z.object({
      artifact: reportArtifact,
      summary: z.string(),
    }).nullable(),
  }).optional(),
  run: z
    .object({
      role,
      thread: z.string(),
      instance: z.string(),
      purpose: z.string(),
      reservedAt: timestamp,
      lastSendAt: timestamp.nullable(),
      revoked: z.boolean(),
      activity: z
        .object({ label: z.string(), startedAt: timestamp.nullable() })
        .nullable(),
    })
    .nullable(),
});
const readiness = z.enum(["ready", "pending", "unavailable"]);
const next = current.extend({
  allowance: allowance.optional(),
  dependencyEdits,
  commands: z.array(
    z.union([
      z.object({ name: z.literal("move"), phase, preflight: readiness }),
      z.object({
        name: z.enum([
          "answer",
          "cancel",
          "amend",
          "hold",
          "release",
          "complete",
          "move_work",
          "set_dependencies",
          "set_prerequisite_wait",
        ]),
        preflight: readiness,
      }),
    ]),
  ),
});
const historyRecord = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_started"),
    instance: z.string(),
    role,
    purpose: z.string(),
    reviewHead: head.nullable(),
  }),
  z.object({ kind: z.literal("run_ended"), instance: z.string() }),
  z.object({ kind: z.literal("pull_request"), url: z.httpUrl() }),
  z.object({ kind: z.literal("verdict"), verdict }),
  z.object({ kind: z.literal("question"), question }),
  z.object({ kind: z.literal("merged"), commit: head }),
  z.object({ kind: z.literal("finished"), phase }),
]);
const history = z.array(
  z.object({
    sequence: revision,
    content: z.object({ at: timestamp }),
    presentation: z.array(historyRecord),
  }),
);
const summaries = z.array(summary);
const applied = z.union([
  summary,
  z.object({ status: z.literal("pending"), version: revision }),
]);
const change = z.object({ taskId: z.string(), version: revision });
type BoardRequest = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

export type RustPhase = z.infer<typeof phase>;
export type RustQuestion = z.infer<typeof question>;
export type RustTask = z.infer<typeof summary>;
export type RustTaskDetail = z.infer<typeof detail>;
export type RustNext = z.infer<typeof next>;
export type RustVerdict = z.infer<typeof verdict>;
export type RustDependencyFact = z.infer<typeof dependencyFact>;
export type RustDependencyStatus = z.infer<typeof dependencyStatus>;
export type RustHistoryPage = z.infer<typeof history>;
export type RustCommand =
  | { move: RustPhase }
  | { move_work: { instruction: string } }
  | { complete: { version: number; artifact: z.infer<typeof reportArtifact>; reason: string } }
  | {
      answer:
        | { work: string }
        | "retry"
        | "extend"
        | { accept: { head: string; reason: string } };
    }
  | { amend: string }
  | { set_dependencies: { version: number; depends_on: string[] } }
  | { hold: string }
  | "cancel"
  | "release";

const taskPath = (id: string) => "/tasks/" + encodeURIComponent(id);

export function createRustBoardTransport(fetcher: typeof fetch = fetch) {
  async function read<T>(
    schema: z.ZodType<T>,
    path: string,
    options?: BoardRequest,
  ): Promise<T> {
    const response = await requestRustBoard(path, options, fetcher);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const refusal = z
        .object({
          error: z.union([z.string(), z.object({ message: z.string() })]),
        })
        .safeParse(body);
      const error = refusal.data?.error;
      throw new Error(
        typeof error === "string"
          ? error
          : (error?.message ?? `Engine request failed (${response.status})`),
      );
    }
    const result = schema.safeParse(body);
    if (!result.success)
      throw new Error("The task engine returned an invalid response.");
    return result.data;
  }

  return {
    read,
    list: (signal: AbortSignal) => read(summaries, "/tasks", { signal }),
    detail: (id: string, signal: AbortSignal) =>
      read(detail, taskPath(id), { signal }),
    next: (id: string, signal: AbortSignal) =>
      read(next, taskPath(id) + "/next", { signal }),
    history: (id: string, before: number | undefined, signal: AbortSignal) => {
      const search = new URLSearchParams({ limit: String(historyPageSize) });
      if (before !== undefined) search.set("before", String(before));
      return read(history, taskPath(id) + "/history?" + search, { signal });
    },
    command: (id: string, command: RustCommand) =>
      read(applied, taskPath(id) + "/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    events: (signal: AbortSignal) =>
      requestRustBoard("/events", { signal }, fetcher),
  };
}

export function requestRustBoard(
  path: string,
  options?: BoardRequest,
  fetcher: typeof fetch = fetch,
) {
  return fetcher(api + path, {
    ...options,
    headers: { ...options?.headers, "x-nucleus-board": "1" },
  });
}

const transport = createRustBoardTransport();
const pushQuery = {
  staleTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

export function useRustTasks(enabled: boolean) {
  return useQuery({
    ...pushQuery,
    queryKey: listKey,
    enabled,
    queryFn: ({ signal }) => transport.list(signal),
  });
}

export function useRustDetail(id: string, showHistory: boolean) {
  const key = taskKey(id);
  const task = useQuery({
    ...pushQuery,
    queryKey: [...key, "detail"],
    queryFn: ({ signal }) => transport.detail(id, signal),
  });
  const next = useQuery({
    ...pushQuery,
    queryKey: [...key, "next"],
    queryFn: ({ signal }) => transport.next(id, signal),
  });
  const history = useInfiniteQuery({
    ...pushQuery,
    queryKey: [...key, "history"],
    enabled: showHistory,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      transport.history(id, pageParam, signal),
    getNextPageParam: (page) =>
      page.length === historyPageSize ? page.at(-1)?.sequence : undefined,
  });
  return { task, next, history };
}

export const postRustCommand = transport.command;
export type RustInvalidation = (id?: string) => void;

/** Activity and readiness notices can share the stored task revision. */
export function rustInvalidationFromFrame(
  frame: LiveFrame,
  invalidate: RustInvalidation,
) {
  if (frame.event === "refresh") {
    invalidate();
  } else if (frame.event === "invalidate" && frame.data !== null) {
    try {
      const parsed = change.safeParse(JSON.parse(frame.data));
      if (parsed.success) invalidate(parsed.data.taskId);
    } catch {
      // Ignore malformed events. A subsequent refresh or invalidation recovers the view.
    }
  }
}

export function createRustInvalidator(client: QueryClient): RustInvalidation {
  const invalidate = createPushInvalidator(client);
  return (id) =>
    invalidate({
      queryKey: root,
      predicate: ({ queryKey }) =>
        id === undefined || queryKey[1] === "list" || queryKey[2] === id,
    });
}

export function createPushInvalidator(client: QueryClient) {
  const waiting = new Set<string>();
  return (filters: QueryFilters) => {
    const queries = client.getQueryCache().findAll(filters);
    for (const query of queries) {
      if (waiting.has(query.queryHash)) continue;
      const refresh = () => {
        waiting.delete(query.queryHash);
        void client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
      };
      // A read already on the wire may finish with older data. Give it one
      // trailing read without cancelling in-flight reads on a busy board.
      if (query.state.fetchStatus === "fetching" && query.promise) {
        waiting.add(query.queryHash);
        void query.promise.then(refresh, refresh);
      } else {
        refresh();
      }
    }
  };
}

export async function listenForRustChanges(
  invalidate: RustInvalidation,
  signal: AbortSignal,
  board?: {
    settingsChanged: () => void;
    themeChanged?: () => void;
    connection: (state: "live" | "retrying" | "expired") => void;
  },
) {
  while (!signal.aborted) {
    try {
      const response = await transport.events(signal);
      if (response.status === 401) {
        board?.connection("expired");
        return;
      }
      if (!response.ok || !response.body)
        throw new Error("Task activity stream unavailable");
      board?.connection("live");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          const read = readLiveFrames(
            pending + decoder.decode(value, { stream: true }),
          );
          pending = read.rest;
          for (const frame of read.frames) {
            rustInvalidationFromFrame(frame, invalidate);
            if (frame.event === "settings" || frame.event === "refresh")
              board?.settingsChanged();
            if (frame.event === "theme" || frame.event === "refresh")
              board?.themeChanged?.();
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // The engine emits refresh on every reconnect, including after a restart.
    }
    if (signal.aborted) return;
    board?.connection("retrying");
    await new Promise<void>((resolve) => {
      const resume = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", resume);
        resolve();
      };
      const timer = setTimeout(resume, 3000);
      signal.addEventListener("abort", resume, { once: true });
    });
  }
}

export const rustColumns = {
  queued: "queue",
  working: "working",
  report_ready: "review",
  blocked: "needs",
  error: "needs",
  reviewing: "review",
  merging: "merging",
  closing: "closing",
  done: "history",
  cancelled: "history",
} as const satisfies Record<RustPhase, string>;

export type RustBoardView = (typeof rustColumns)[RustPhase] | "needs";
export type RustExtraView = Extract<RustBoardView, "merging" | "history">;

export function groupRustTasks(
  tasks: readonly RustTask[],
): Record<RustBoardView, RustTask[]> {
  const columns: Record<RustBoardView, RustTask[]> = {
    needs: [],
    queue: [],
    working: [],
    review: [],
    merging: [],
    closing: [],
    history: [],
  };
  for (const task of tasks) {
    const column = rustColumns[task.phase];
    columns[column].push(task);
    if (column !== "history" && column !== "needs" && task.question) columns.needs.push(task);
  }
  return columns;
}

export const rustPhaseLabels: Record<RustPhase, string> = {
  queued: "Queued",
  working: "Working",
  report_ready: "Report ready",
  blocked: "Blocked",
  error: "Error",
  reviewing: "Reviewing",
  merging: "Merging",
  closing: "Closing",
  done: "Done",
  cancelled: "Cancelled",
};

const waits: Record<string, string> = {
  hold: "On hold",
  question: "Waiting for the planner",
  host_unknown: "Waiting for the host",
  operator_declined: "The operator declined. Move or cancel the task.",
  starting: "Starting",
  running: "Running",
  idle_without_terminal_run: "Waiting for the host",
  permission: "Waiting for permission",
  usage_permission: "Low usage requires operator approval",
  input: "Waiting for input",
  retained_thread_busy: "Waiting for the previous turn",
  stopping: "Stopping",
  forge_unknown: "Waiting for GitHub",
  workspace_unknown: "Checking the workspace",
  checks_pending: "Waiting for checks",
  prerequisite: "Waiting for prerequisite",
};

export function rustWaitText({
  wait,
  phase,
}: Pick<RustTask, "wait" | "phase">) {
  if (wait === "capacity")
    return phase === "reviewing"
      ? "Waiting for a review slot"
      : "Waiting for a work slot";
  return wait ? (Object.hasOwn(waits, wait) ? waits[wait] : "Waiting") : null;
}

const repairPrompts: Record<z.infer<typeof repair>, string> = {
  pull_request_unavailable: "The pull request could not be confirmed.",
  workspace_head_mismatch: "The workspace differs from the pull request head.",
  revision_has_same_head:
    "The revision still has the previously reviewed head.",
  merge_blocked: "GitHub is blocking the merge.",
  merge_unconfirmed: "GitHub has not confirmed the merge.",
};

export function rustQuestionText(question: RustQuestion): string {
  if ("work" in question) return question.work.prompt;
  if ("retry" in question)
    return `The ${question.retry.role} could not finish. Try again?`;
  if ("accept" in question) return "Accept the external merge?";
  if ("allowance" in question) return "The task needs more allowance before its next run.";
  return repairPrompts[question.repair];
}

export function rustTaskLabel(task: RustTask): string {
  return task.reference || task.identity.reference || task.identity.id;
}

/** A dependency's status in task detail, worded as the TypeScript prerequisite list words it. */
export function rustDependencyText(fact: RustDependencyFact): string {
  return `${rustDependencyTitle(fact)} · ${rustDependencyState(fact)}`;
}

const rustDependencyTitle = (fact: RustDependencyFact) =>
  fact.title || fact.reference || "Prerequisite";

function rustDependencyState(fact: RustDependencyFact): string {
  switch (fact.status) {
    case "satisfied":
      return "complete";
    case "removed":
      return "removed before completion";
    case "goal_unmet":
      return "goal unmet";
    case "missing":
      return "missing";
    case "cancelled":
      return rustPhaseLabels.cancelled;
    case "pending":
      return fact.phase ? rustPhaseLabels[fact.phase] : "pending";
  }
}

/** The prerequisites a task is still waiting on: an unreleased wait's list, then its dependencies. */
export function rustUnfinishedPrerequisites({
  dependencies,
  prerequisiteWait,
}: RustDependencyStatus): RustDependencyFact[] {
  const waiting =
    prerequisiteWait && prerequisiteWait.releasedAtMs === null
      ? prerequisiteWait.prerequisites
      : [];
  const seen = new Set<string>();
  return [...waiting, ...dependencies].filter((fact) => {
    if (fact.status === "satisfied") return false;
    // A redacted prerequisite has no identity to share, so it always counts once.
    if (!fact.taskId) return true;
    if (seen.has(fact.taskId)) return false;
    seen.add(fact.taskId);
    return true;
  });
}

/** The card's prerequisite detail for a blocked Rust task, through the shared card formatter. */
export function rustPrerequisiteLine({
  dependencyStatus: status,
}: Pick<RustTask, "dependencyStatus">): string | null {
  if (!status.blocking) return null;
  const unfinished = rustUnfinishedPrerequisites(status);
  const wait =
    status.prerequisiteWait?.releasedAtMs === null
      ? status.prerequisiteWait
      : null;
  return prerequisiteSummary(
    unfinished[0]?.reference || null,
    unfinished.length
      ? unfinished.map((fact) => ({
          title: fact.title || "Prerequisite",
          status: rustDependencyState(fact),
        }))
      : wait?.reason
        ? [{ title: wait.reason, status: "" }]
        : [],
  );
}
