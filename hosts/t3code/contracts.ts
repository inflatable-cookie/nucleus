import { z } from "zod";

const id = z.string().min(1);
const date = z.string().min(1);
/** A model's option choice: one selectable value of one option descriptor (nightly `ProviderOptionChoice`). */
export const optionChoice = z.object({
  id,
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
/**
 * One configurable option of a model (nightly `ProviderOptionDescriptor`):
 * a select with its choices or a boolean toggle, `currentValue` when the provider reports one.
 * `role: "reasoning"` is the nightly's marker for a provider's own thought-level control;
 * every stock driver names its reasoning select `reasoningEffort`.
 */
export const optionDescriptor = z.discriminatedUnion("type", [
  z.object({
    id,
    label: z.string(),
    description: z.string().optional(),
    type: z.literal("select"),
    options: z.array(optionChoice),
    currentValue: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    id,
    label: z.string(),
    description: z.string().optional(),
    type: z.literal("boolean"),
    currentValue: z.boolean().optional(),
  }),
]);
/**
 * The nightly's runtime-mode contract (`packages/contracts/src/providerPolicy.ts`
 * in the source, `RuntimeMode` in the installed bundle): four thread-wide modes,
 * narrowest first, with `full-access` as the default a thread is launched with.
 * A provider reports the subset it offers as `supportedRuntimeModes`; omitting
 * the field means it offers all four, and a request outside the reported subset
 * silently runs as `approval-required` (`providerRuntimeMode`). The adapter never
 * relies on that downgrade: the catalog reports this list per provider and the
 * launch fence refuses a mode the provider does not offer.
 */
export const runtimeModes = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const runtimeMode = z.enum(runtimeModes);
export type RuntimeMode = z.infer<typeof runtimeMode>;
/** The mode a launch uses when the profile names none (`DEFAULT_RUNTIME_MODE`). */
export const defaultRuntimeMode: RuntimeMode = "full-access";
export const modelCapabilities = z.object({
  optionDescriptors: z.array(optionDescriptor).optional(),
});
/**
 * The nightly's `ServerProviderModel.capabilities` is `NullOr(ModelCapabilities)`:
 * a model T3 has not probed yet reports `null`, which reads as no options here
 * rather than failing the whole `server.getConfig` decode. Whether that absence
 * is a settled fact or a provider mid-probe is the thinking carrier's decision
 * (`. /thinking`), never this schema's.
 */
export const modelCapabilitiesOrNull = modelCapabilities.nullable();
export const modelSelection = z.object({ instanceId: id, model: id });
export const threadRecord = z.object({
  id,
  projectId: id,
  title: z.string(),
  providerInstanceId: id,
  modelSelection,
  /** The thread's runtime mode. The nightly always reports it; retained only when present for older shapes. */
  runtimeMode: runtimeMode.optional(),
  /** Nightly's manual settled marker; a new message dispatch clears it. */
  settledOverride: z.enum(["settled", "active"]).nullable(),
  settledAt: date.nullable(),
  /**
   * The instant a snooze wakes (nucleus#1366). A snoozed thread is out of the
   * client's active list until then, wakes early on a guest message, a pending
   * runtime request or a failed run, and is never auto-settled while snoozed.
   */
  snoozedUntil: date.nullable().optional(),
  pinnedAt: date.nullable().optional(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  archivedAt: date.nullable(),
  deletedAt: date.nullable(),
  updatedAt: date,
});
/**
 * One pending background task a provider thread reports (nightly
 * `OrchestrationV2PendingBackgroundTask`). The nightly derives it from the
 * provider session's own state, so it names work that can outlive its run.
 */
export const pendingBackgroundTask = z
  .object({
    taskId: id,
    kind: id,
    description: z.string().optional(),
    parentTaskId: z.string().optional(),
    awaited: z.literal(true).optional(),
    providerInstanceId: id.optional(),
    childThreadId: id.optional(),
  })
  .passthrough();
export const shellThread = threadRecord.extend({
  activeRunId: id.nullable(),
  status: z.enum([
    "idle",
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ]),
  pendingRuntimeRequest: z
    .object({ id, kind: id, createdAt: date, blocking: z.boolean().optional() })
    .nullable(),
  pendingBackgroundTasks: z.array(pendingBackgroundTask).optional(),
  latestUserMessageAt: date.nullable(),
  lastError: z.string().nullable().optional(),
});
export const project = z.object({
  id,
  title: z.string(),
  workspaceRoot: id,
  archivedAt: date.nullable().optional(),
});
export const shellSnapshot = z.object({
  schemaVersion: z.number().int().positive(),
  snapshotSequence: z.number().int().nonnegative(),
  projects: z.array(project),
  threads: z.array(shellThread),
  archivedThreads: z.array(shellThread),
});
export const runtimeRequest = z.object({
  id,
  kind: id,
  status: z.enum(["pending", "resolved", "expired", "cancelled"]),
  responseCapability: z.discriminatedUnion("type", [
    z.object({ type: z.literal("live"), providerSessionId: id }),
    z.object({ type: z.literal("message") }),
    z.object({ type: z.literal("not_resumable"), reason: z.string() }),
  ]),
  answers: z.record(z.string(), z.unknown()).optional(),
});
const question = z.object({
  id,
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string() })),
});
export const turnItem = z
  .object({
    id,
    type: id,
    requestId: id.optional(),
    /** A user message's own id: the identity an operator command is served by (nucleus#1415). */
    messageId: id.optional(),
    /** A user message's text, verbatim. */
    text: z.string().optional(),
    /** The run that owns the item; one run is one provider turn. Null on thread-level items. */
    runId: id.nullable().optional(),
    /** The item's position in its thread: consecutive positions are consecutive rows. */
    ordinal: z.number().int().nonnegative(),
    questions: z.array(question).optional(),
    createdAt: date.optional(),
    updatedAt: date.optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    if (
      item.type === "user_input_request" &&
      (!item.requestId || !item.questions)
    )
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Missing question fields",
      });
  });
/**
 * One rendered timeline row (nightly `OrchestrationV2ProjectedTurnItem`). The
 * nightly windows these rows, so the collection is the visible window itself;
 * `visibility` is `local` for this thread's own rows and `inherited` or
 * `synthetic` for a row it shows from elsewhere.
 */
export const visibleTurnItem = z.object({
  position: z.number().int().nonnegative(),
  visibility: id.optional(),
  sourceThreadId: id.optional(),
  sourceItemId: id,
  item: turnItem,
});
/**
 * One delegated task of a thread (the nightly's `OrchestrationV2Subagent`): the
 * record a task's parent thread carries for each native child, including the state
 * of the completion wake that must never reach the parent agent. `app_owned` marks a
 * child the app created (`delegated_task.request` or a follow-up dispatch); the task
 * id is `node:delegated-task:<commandId>` and its thread id
 * `thread:delegated-task:<commandId>`.
 */
export const subagent = z
  .object({
    id,
    threadId: id.optional(),
    runId: id.nullable().optional(),
    parentNodeId: id.optional(),
    origin: id,
    childThreadId: id.nullable().optional(),
    prompt: z.string().optional(),
    title: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    status: id,
    result: z.string().nullable().optional(),
    completionDelivery: z
      .object({ state: id, observedByRunId: id.nullable().optional() })
      .optional(),
  })
  .passthrough();
/**
 * The delivery states the nightly records for one delegated task's completion. Only
 * `pending` can still wake the parent; `disposed` is the settled state Nucleus asks
 * for, and a task already `disposed` answers a repeated dispose without an effect.
 */
export const delegatedDeliveryStates = [
  "pending",
  "claimed",
  "acknowledged",
  "delivered",
  "disposed",
] as const;
/** The wake policies a delegated task may name; `settled_only` never wakes a live parent. */
export const completionWakeValues = ["always", "settled_only"] as const;
/** Window-retained provider threads: active threads, referenced threads and the latest todo owner. */
export const providerThread = z
  .object({
    id,
    pendingBackgroundTasks: z.array(pendingBackgroundTask).optional(),
  })
  .passthrough();
export const projection = z.object({
  thread: threadRecord,
  // `rootNodeId` is the run's own root node (recorded `runKeys`): the parent node
  // a `thread.created.record` card on that run must name.
  runs: z.array(
    z.object({
      id,
      status: shellThread.shape.status,
      startedAt: date.nullable(),
      ordinal: z.number().int().nonnegative().optional(),
      rootNodeId: id.nullable().optional(),
    }),
  ),
  runtimeRequests: z.array(runtimeRequest),
  turnItems: z.array(turnItem),
  /** The nightly's own visible window; absent only on a projection decoded before this field was read. */
  visibleTurnItems: z.array(visibleTurnItem).optional(),
  providerThreads: z.array(providerThread).optional(),
  /** Every delegated task the thread carries; the parent's own children are here. */
  subagents: z.array(subagent).optional(),
  /**
   * The thread's messages. A message T3 has queued behind a live run is here before it is a
   * turn item, so this is the record an operator command is served from (nucleus#1415);
   * `runId` names the run the message started.
   */
  messages: z.array(
    z.object({
      id,
      role: id,
      text: z.string(),
      runId: id.nullable().optional(),
    }),
  ),
  updatedAt: date,
});
/** Coverage flags are consumed facts, not optional hints that can be truthiness-tested. */
export const threadSnapshot = z.object({
  kind: z.literal("snapshot"),
  snapshotSequence: z.number().int().nonnegative(),
  projection,
  hasMoreHistory: z.boolean().optional(),
  historyCursor: id.nullable().optional(),
  latestLocalTurnOrdinal: z.number().int().nonnegative().nullable().optional(),
  turnItemsOmitLocalVisible: z.boolean().optional(),
  idTable: z.literal(true).optional(),
});
export const config = z.object({
  environment: z.object({
    environmentId: id,
    serverVersion: id,
    orchestrationProtocolVersion: z.literal(2),
  }),
  /**
   * The server settings this adapter reads, and never writes: a client hides a
   * top-level thread whose tag is in `hiddenThreadTags` while
   * `hideTaggedThreads` is on (recorded contract `supportRows`). Absent means a
   * nightly that reports no settings, which reads as both defaults.
   */
  settings: z
    .object({
      hideTaggedThreads: z.boolean().optional(),
      hiddenThreadTags: z.array(z.string()).optional(),
      providerInstances: z
        .record(
          z.string(),
          z
            .object({
              driver: z.string().optional(),
              enabled: z.boolean().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .optional(),
  providers: z.array(
    z.object({
      instanceId: id,
      displayName: z.string().optional(),
      enabled: z.boolean(),
      /**
       * The nightly's provider driver (`acpRegistry` for an ACP provider an operator
       * registered in settings). Read-only capability fact: the native-parent path
       * needs the Nucleus ACP instance, and a driver it does not report is not refused
       * on its own (an older nightly may omit it).
       */
      driver: z.string().optional(),
      /** The nightly `ServerProvider` field: the runtime modes this provider offers. Absent means all four. */
      supportedRuntimeModes: z.array(runtimeMode).optional(),
      status: z.string(),
      message: z.string().nullable().optional(),
      models: z.array(
        z.object({
          slug: id,
          name: z.string(),
          aliases: z.array(z.string()).optional(),
          capabilities: modelCapabilitiesOrNull.optional(),
        }),
      ),
    }),
  ),
});

export const previewNavStatus = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Idle") }).passthrough(),
  z
    .object({ _tag: z.literal("Loading"), url: z.string(), title: z.string() })
    .passthrough(),
  z
    .object({ _tag: z.literal("Success"), url: z.string(), title: z.string() })
    .passthrough(),
  z
    .object({
      _tag: z.literal("LoadFailed"),
      url: z.string(),
      title: z.string(),
      code: z.number().int(),
      description: z.string(),
    })
    .passthrough(),
]);
export const previewSession = z
  .object({
    threadId: id,
    tabId: id,
    navStatus: previewNavStatus,
    reveal: z.boolean().optional(),
    updatedAt: z.string(),
  })
  .passthrough();
export const previewList = z
  .object({
    sessions: z.array(previewSession),
  })
  .passthrough();

/**
 * How much of a thread's timeline one `subscribeThread` snapshot carries.
 *
 * The nightly answers a bounded snapshot only to a client that asks for one
 * (`acceptBoundedSnapshot`). It then keeps the thread record, every run and
 * every runtime request in full and windows only the timeline, so `paged`
 * describes the transcript and never the state observation reads.
 * `hasMoreHistory` and `historyCursor` are a pair: a window that left earlier
 * history behind sets both, a complete snapshot sets neither, and any other
 * combination is a coverage claim the adapter cannot use. `idTable` is the
 * compact-id codec's wire shape, which the plain decode here does not expand.
 */
export interface ThreadSnapshotCoverage {
  paged: boolean;
  omitsTurnItems: boolean;
}
export function threadSnapshotCoverage(
  snapshot: z.infer<typeof threadSnapshot>,
): ThreadSnapshotCoverage {
  const paged = snapshot.hasMoreHistory === true;
  const cursor = snapshot.historyCursor ?? null;
  if (paged !== (cursor !== null))
    throw new T3CompatibilityError(
      `subscribeThread: hasMoreHistory ${paged} with ${cursor === null ? "no cursor" : "a cursor"}`,
    );
  if (snapshot.idTable !== undefined)
    throw new T3CompatibilityError("subscribeThread: idTable");
  return { paged, omitsTurnItems: snapshot.turnItemsOmitLocalVisible === true };
}

export class T3CompatibilityError extends Error {
  constructor(readonly field: string) {
    super(`T3Code compatibility check failed: ${field}`);
    this.name = "T3CompatibilityError";
  }
}
export function decode<T>(schema: z.ZodType<T>, value: unknown, at: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new T3CompatibilityError(
      `${at}.${result.error.issues[0]?.path.join(".") || "response"}`,
    );
  return result.data;
}
