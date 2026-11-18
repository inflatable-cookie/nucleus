import { recordQaServiceLifecycle } from "../core/qa/project-qa-diagnostics";
import { initializeWorkRoot } from "../core/workspaces/work-root.mjs";
import { registerServiceRollRequest } from "./install/roll-request";
import { currentServiceBuildId } from "../shared/service/build";
import { HostCatalogueSettings } from "./host-settings";
import { RuntimeQuestions } from "../core/runtime/questions";
import { RuntimeSettings } from "../core/runtime/settings";
import { ParticipantTickets } from "../core/dispatch/participant-tickets";
import { RuntimeRepositories } from "../core/runtime/repositories";
import { RuntimePlanning } from "../core/runtime/planning";
import { RuntimeBoard } from "../core/runtime/board";

import { compiledIdentity, stableInstalledPath } from "../shared/runtime.mjs";
import { sourcePathFromModule } from "../shared/service/build";
import { pluginRegistration } from "../shared/plugin-discovery.mjs";
import { qaFenceStatus } from "../core/qa/qa-fence";
import type { ProjectQaFenceInput } from "../shared/contracts";
import { pidAlive } from "../core/machine/process-identity";
import {
  defaultDataDir,
  markMaintenance,
  markMigration,
  SPAWN_TOKEN_ENV,
} from "./install/standby";
/**
 * Explicit Queue runtime owner (Spec 013 first-cutover step 1).
 *
 * Runtime construction moves out of module globals into this owner with
 * explicit start, health, drain and stop phases. Construction proves single
 * database ownership before any handler exists; startup failures are captured
 * into the owner instead of an import-time throw. Handler behavior is
 * unchanged: every method below keeps its previous name, schema and semantics.
 */
import { readPrStates } from "../core/forge/pr-status";
import type { BbSidebarGroups } from "../shared/schema/bb-sidebar";
import { type ProfileSettings } from "../shared/pool";

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../core/store/store";
import { StoreCompactor, freeBytesOn } from "../core/store/store-compaction";
import { backupDirForDataDir } from "../core/store/backups";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import { formatAgentId, parseAgentId } from "../shared/agent-identity";
import { hostKindOf, type HostKind } from "../shared/host-kind";
import { hostConnected } from "../core/host";
import { createHost, paseoHome } from "../hosts/paseo";
import type { RegistrationAdapter } from "../core/host/registration";
import type { Adapter } from "../core/host/adapter";
import { HostFacade } from "../core/host/host-facade";
import {
  Admission,
  admitAdapter,
  type AdmissionOptions,
} from "../core/host/admission";
import {
  HostRegistry,
  HOST_IDLE_GRACE_MS,
  type KnownHost,
} from "../core/host/host-registry";
import type { IdentitySource } from "../shared/host-kind";
import { T3HostConnection, type T3ConnectionConfig } from "./t3code-host";
import {
  readT3Connection,
  sameT3Connection,
  settingsFileStamp,
  t3SettingsPath,
} from "../shared/t3/settings";
import {
  BbHostConnection,
  recordBbPresentationParentChange,
  type BbHostRejectedInput,
  type BbHostReleasedInput,
  type BbHostVerifiedInput,
} from "./bb-host";
import {
  HostConnections,
  wireEngineHosts,
  type HostConnectionOwner,
} from "./host-connections";
import { RuntimeLifecycle, type RuntimePhase } from "./runtime-lifecycle";
import { RuntimeHealthProjection, type RuntimeHealth } from "./runtime-health";

/** The health contract and phase are owned by those modules; re-exported for the service's own surfaces. */
export type { RuntimeHealth, RuntimePhase };
import {
  StoreMaintenance,
  type StoreMaintenanceOwner,
} from "./store-maintenance";
import { answerHostPermission } from "./host-permissions";
import {
  lifecycleSignalSchema,
  type LifecycleSignal,
  type LifecycleSignalReceipt,
} from "../shared/lifecycle-signal";
import { RequestLedger } from "../core/runtime/request-ledger";
import { Engine, controlHasExternalEffect } from "../core/engine";

import {
  taskControlOperation,
  TASK_CONTROL_KEY_LIMIT,
} from "../core/verbs/task-control-key";
import { startCallbacks } from "./callbacks/callback";
import { AcpSessions, bindAcpSession } from "../core/acp/sessions";

import type {
  SnapshotState,
  SnapshotInput,
  UsageLevel,
  DemandRoleOffsets,
  Submission,
  PoolEntry,
  BulkDispositionRequest,
  ReparentInput,
  TaskControlRequest,
  ReviewEntryInput,
  OutcomeSearchInput,
} from "../shared/contracts";
import { taskControlChanges } from "../shared/task-control-changes";
import {
  type OperationAcceptance,
  type OperationResult,
} from "../shared/operations";
import {
  capacitySchema,
  projectDispatchLimitSchema,
  DEFAULT_GLOBAL_LIMIT,
  DEFAULT_UNCERTAIN_MERGE_RETRY_MS,
  UNCERTAIN_MERGE_PROOF_TIMEOUT_MS,
  sourcePromotionInputSchema,
  submissionSchema,
  submitInstruction as submitInstructionRpc,
  reviewEntryReconcileInputSchema,
  BACKUP_DUE_CHECK_MS,
  type BoundRun,
} from "../shared/contracts";
import {
  createTelemetrySnapshotCache,
  taskControlTelemetry,
} from "../core/telemetry/telemetry";
import { RunUsageTracker } from "../core/telemetry/run-usage-tracker";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { QA_BOARD_PASS_FADE_MS } from "../core/qa/qa-board";

import { type CheckRequirementTransport } from "../core/forge/index";
import { now, operationInputHash } from "../core/store/store";

import type {
  HostRunAccountingDisposeInput,
  RepositorySetInput,
  ProjectUpsertInput,
  Task,
  RepositoryRekeyInput,
  RepositoryRekeyOutput,
  RepositoryRekeyPreviewInput,
  RepositoryRekeyReceiptQuery,
} from "../shared/contracts";
import {
  prepareReviewEntryWorkspace,
  previewReviewEntry,
  reconcileReviewEntryOperation,
  type ReviewEntryAdapter,
} from "../core/review/review-entry";
import {
  originReviewProof,
  withOriginReviewAdapter,
} from "../core/review/origin-review-adapter";
import { Papercuts } from "../core/planning/papercut-operations";
import { Leads } from "../core/planning/leads";
import { Decisions } from "../core/planning/decisions";

import { ProjectQaRunner } from "../core/qa/project-qa";
import { ProjectQaSchedules } from "../core/qa/project-qa-schedule";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { captureCpuProfile } from "../core/telemetry/cpu-profile";
import { EventLoopDelayMonitor } from "../core/telemetry/event-loop-delay";
import {
  LiveRunPresence,
  LIVE_RUN_PRESENCE_INTERVAL_MS,
  type RunPresenceDaemon,
} from "../core/telemetry/live-run-presence";
import {
  assertHostRunStateDirSafe,
  HostRunEndpoint,
  hostRunStateDirForDataDir,
} from "./callbacks/host-run-endpoint";
import type { HostRunFront } from "./executor/host-run-front";
import { EffigyAdmissionEndpoint } from "./callbacks/effigy-admission-endpoint";
import {
  effigyRuntimeSettingsSchema,
  type EffigyRuntimeSettings,
  type EffigyVersion,
} from "../core/qa/effigy-runtime";

import { CapacityChangeJournal } from "../core/dispatch/capacity-changes";

import {
  defaultAdmissionHookCommand,
  queueOwnedAdmissionEnvironment,
} from "../core/qa/effigy-admission";
import { hostRunAdmissionSocketPath } from "../core/host-runs/host-run-paths";
import type { Papercut } from "../shared/contracts";

/**
 * Sweep cadence. Every step of a task's tail that has no callback of its own waits
 * for this pass, so the interval is the floor on how fast a pipeline can drain.
 * Bounded work per pass keeps it cheap: one page over the active fleet, plus one
 * rotating page of the capacity-blocked queue.
 */
const SWEEP_INTERVAL_MS = 20_000;
/** Subscription availability changes slowly; refreshing it is its own separate pass. */
const PROFILE_REFRESH_INTERVAL_MS = 120_000;

/** After the last plugin presence closes while a host is still connected, wait this long before raising the board fault. A successful reload inside the window is silent. */
const PLUGIN_PRESENCE_GRACE_MS = 45_000;

/** The host's `settings.json` shape. Uncertain merge timing and the trusted Effigy runtime are per-host settings. */
export interface HostSettings {
  daemonUrl: string;
  password?: string;
  workRoot?: string;
  workVolumeId?: string;
  uncertainMergeRetryMs?: number;
  /** Spec 035 "Runtime identity": the immutable Effigy artifact Queue may observe with. */
  effigyRuntime?: EffigyRuntimeSettings;
  /** Optional private T3 session configuration; never returned by service health/settings. */
  t3code?: T3ConnectionConfig;
}

export interface RuntimeOwnerOptions {
  /** Data directory override; defaults to the one data-home resolver (`shared/data-home.mjs`). */
  dataDir?: string;
  /** Paseo home used to locate the installed plugin source. */
  paseoHome?: string;
  /** Installed plugin source path override (checked for `mcp-report.mjs`). */
  sourcePath?: string;
  /** Adapter override for fixtures; the default builds the real Paseo adapter. */
  adapterFactory?: (context: {
    dataDir: string;
    settings: HostSettings;
  }) => Adapter;
  /** Settings override for fixtures. */
  settings?: HostSettings;
  /** Set false in tests that must not leave live timers behind. */
  timers?: boolean;
  /** Sweep cadence override for fixtures; a real service uses the documented 20 s pass. */
  sweepIntervalMs?: number;
  /** Bounded Paseo admission overrides; production uses the documented defaults. */
  admission?: AdmissionOptions;
  /** Bounded daemon-connect window; defaults to 10 s. */
  connectTimeoutMs?: number;
  /**
   * Idle grace before the daemon closes once no host and no bridge presence is
   * left; defaults to the ruling's ten minutes (`HOST_IDLE_GRACE_MS`). Fixtures
   * shorten it so the decision is proved without waiting.
   */
  hostIdleGraceMs?: number;
  /** Clock used only for host idle-grace bookkeeping; production uses wall time. */
  hostNow?: () => number;
  /**
   * Grace after the last plugin presence closes while a host is still connected,
   * before the board fault; defaults to `PLUGIN_PRESENCE_GRACE_MS`. Fixtures
   * shorten it so the fault is proved without waiting.
   */
  pluginLostGraceMs?: number;
  /** Test-only instrumentation applied to the store immediately after construction; production never sets it. */
  instrumentStore?: (store: Store) => void;
  /**
   * Fixture-only transport for the `repository.set` required-check capability
   * read; production reads the live forge. It is never a merge-gate seam.
   */
  requiredCheckTransport?: CheckRequirementTransport;
  /**
   * Serve contract 010's client-protocol v1 endpoint (Spec 035 part 3). The
   * standalone service enables it; timerless fixtures and the plugin's own
   * tests leave it off so no fixture touches the host authority files.
   */
  hostRunEndpoint?: boolean;
  /** Explicit in-code host-run state root; non-live stores cannot point at the live root outside opted-in tests. */
  hostRunStateDir?: string;
  /**
   * Fixture/host override for the environment the admitted Effigy workload ran
   * in: Queue reads the run journal from it. Production uses this process's own
   * environment, which is the one the daemon launches workers under.
   */
  effigyEnvironment?: NodeJS.ProcessEnv;
  /** Test seam: how an admission ancestor's image answers `--version`. Production asks the image itself. */
  effigyVersion?: (
    path: string,
  ) => EffigyVersion | null | Promise<EffigyVersion | null>;
  /**
   * Fixture-only opt-in naming the live host-run state root for isolated endpoint tests.
   */
  testOnlyAllowLiveHostRunStateDir?: string;
  /**
   * The front worker a warm standby already started and swapped onto the live
   * path before this runtime existed (Spec 035, "Accepts off the runtime loop").
   */
  hostRunFront?: HostRunFront;
  /**
   * Spec 028 store compaction. The production service (timers on, no fixture adapter)
   * attempts the one-shot conversion of a store that still says `auto_vacuum=0` at start,
   * before it serves anything. `false` disables it; an object enables it for a fixture and
   * may supply the verified-snapshot route instead of the `backup.now` child.
   */
  storeCompaction?:
    | false
    | { snapshot?: (path: string) => Promise<{ name: string; bytes: number }> };
}

export class QueueRuntime {
  readonly store: Store;
  /** Settings-only capacity writes: the applied-change record `queue.capacity-state` reads back. */
  readonly capacityChanges: CapacityChangeJournal;
  /** Keyed mutating calls' received-and-settled journal; `service.request-outcome` reads it across a roll. */
  readonly requestLedger: RequestLedger;
  /** Spec 028: the service-owned one-shot conversion of a pre-incremental store. */
  readonly compaction: StoreCompactor;
  private readonly storeCompactionEnabled: boolean;
  /** Spec 058 slice 1: one push stream per live run agent, opened and closed from the sweep tick. */
  private readonly runUsage: RunUsageTracker;
  /** The bridge spawn this process belongs to; the roll's readiness wait is extended by its bounded phases. */
  private readonly spawnToken: string | undefined;
  readonly hostRuns: HostRunScheduler;
  readonly papercuts: Papercuts;
  readonly leads: Leads;
  readonly decisions: Decisions;
  readonly adapter: Adapter;
  /** The Host contract over this runtime's adapter, read at each call (`core/host/host-facade.ts`). */
  get host(): HostFacade {
    return new HostFacade(this.engine ?? this);
  }
  readonly admission: Admission;
  readonly hostRegistry: HostRegistry<{
    adapter: Adapter;
    admission: Admission;
  }>;
  private hostSession: { id: string; token: object } | null = null;
  /**
   * The T3Code connection (Spec: t3code host adapter). Mutable because the
   * operator route `nucleus t3 install` / `uninstall` writes the stored connection
   * while the service runs, and the next bootstrap tick adopts it without a
   * restart (nucleus#1330). Every reader goes through the owner object, so a
   * replaced connection is what health, the lifecycle and the catalogue report.
   */
  private t3Host: T3HostConnection | null;
  /** The connection in force, and the settings-file stamp it was read at. */
  private t3Config: T3ConnectionConfig | null = null;
  private t3SettingsStamp = "";
  /** The one admission factory the secondary host is built with, reused on adoption. */
  private readonly makeAdmission: () => Admission;
  /**
   * The BB host's registration and identity (Spec 062, phase 1). The executor
   * connection itself lives in the service process; this object is the durable
   * identity, the registry claim, the admission and the health projection.
   */
  readonly bbHost: BbHostConnection;
  private readonly hosts: HostConnections;
  private readonly maintenance: StoreMaintenance;
  readonly engine: Engine;
  readonly settings: HostSettings;
  readonly dataDir: string;
  readonly owner = randomUUID();
  private readonly questions: RuntimeQuestions;
  private readonly settingsOperations: RuntimeSettings;
  private readonly repositories: RuntimeRepositories;
  private readonly plannerTickets: ParticipantTickets;
  private readonly planning: RuntimePlanning;
  private readonly board: RuntimeBoard;
  private readonly cachedTaskDetail: ReturnType<typeof createTaskDetailCache>;
  private readonly cachedTelemetrySnapshot: ReturnType<
    typeof createTelemetrySnapshotCache
  >;
  private readonly cachedUiSnapshotFacts: ReturnType<
    typeof createUiSnapshotFactsCache
  >;
  /** The narrow planning-list projection, rebuilt once per durable board revision (lead.board). */
  private boardLeadsCache: {
    revision: number;
    value: ReturnType<Store["listBoardLeads"]>;
  } | null = null;
  /** Phase, bootstrap, refresh and the honest read facts; composition stays here. */
  private readonly lifecycle: RuntimeLifecycle;
  /** Presentation of this runtime's facts; owns what health does and does not know. */
  private readonly healthProjection: RuntimeHealthProjection;
  /** Settings → Hosts (nucleus#1325): the catalogue read and the operator's removal. */
  private readonly hostSettings: HostCatalogueSettings;
  private idleShutdownLatched = false;
  private readonly pluginLostGraceMs: number;
  private closeCallbacks: (() => Promise<void>) | undefined;
  /** Contract 010 client-protocol endpoint; on only when the owner options enable it. */
  private hostRunEndpoint: HostRunEndpoint | null = null;
  /** Queue-owned Effigy admission hook socket; started with the host-run endpoint. */
  private admissionEndpoint: EffigyAdmissionEndpoint | null = null;
  private paseoAdapter: {
    setAdmissionLaunchEnv(env: Record<string, string> | null): void;
  } | null = null;
  /** Why the host-run endpoint is not serving; empty while it serves or when disabled. */
  private hostRunEndpointError = "";
  private readonly serveHostRunEndpoint: boolean;
  private readonly hostRunStateDir: string;
  private readonly effigyEnvironment: NodeJS.ProcessEnv;
  private readonly effigyVersion:
    | ((path: string) => EffigyVersion | null | Promise<EffigyVersion | null>)
    | undefined;
  private readonly hostRunFront: HostRunFront | undefined;
  private timers: NodeJS.Timeout[] = [];
  /** The lifecycle sweep cadence this instance runs (production default, fixture override). */
  private readonly sweepIntervalMs: number;
  private readonly eventLoopDelay = new EventLoopDelayMonitor();
  private scheduledQa: ProjectQaSchedules | null = null;
  /**
   * Task 530: the live run set's terminal tabs and workspace labels. A
   * best-effort projection; it never admits, schedules, settles or changes a task.
   */
  private liveRunPresence: LiveRunPresence | null = null;
  private readonly backupDir: string;
  private readonly connectTimeoutMs: number;
  /** Fixture-only required-check capability transport; production reads the live forge. */
  private readonly requiredCheckTransport:
    | CheckRequirementTransport
    | undefined;
  readonly started: Promise<void>;
  /**
   * Settles once the host-run endpoint has bound (or been skipped or failed).
   * The first board snapshot waits on this so a roll's reconnect window is not
   * spent parsing task blobs.
   */
  readonly hostRunReady: Promise<void>;
  private resolveHostRunReady: () => void = () => {};

  /**
   * The runtime's lifecycle facts stay readable under their historical names:
   * the host-connection seam and the settings surface read them on every call,
   * and `service.health` presents them.
   */
  get phase(): RuntimePhase {
    return this.lifecycle.phase;
  }
  get closing(): boolean {
    return this.lifecycle.closing;
  }
  get bootstrapped(): boolean {
    return this.lifecycle.bootstrapped;
  }
  set bootstrapped(value: boolean) {
    this.lifecycle.bootstrapped = value;
  }
  get bootstrap(): Promise<void> | null {
    return this.lifecycle.bootstrap;
  }
  get bootstrapRunning(): Promise<void> | null {
    return this.lifecycle.bootstrapRunning;
  }
  get startError(): string {
    return this.lifecycle.startError;
  }
  set startError(value: string) {
    this.lifecycle.startError = value;
  }
  get lastStoreAccessAt(): string | null {
    return this.lifecycle.lastStoreAccessAt;
  }

  constructor(options: RuntimeOwnerOptions = {}) {
    registerServiceRollRequest();
    this.hostRunReady = new Promise<void>((resolve) => {
      this.resolveHostRunReady = resolve;
    });
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.requiredCheckTransport = options.requiredCheckTransport;
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.serveHostRunEndpoint = options.hostRunEndpoint === true;
    this.hostRunStateDir =
      options.hostRunStateDir ?? hostRunStateDirForDataDir(this.dataDir);
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.pluginLostGraceMs =
      options.pluginLostGraceMs ?? PLUGIN_PRESENCE_GRACE_MS;
    this.hostRunFront = options.hostRunFront;
    this.effigyEnvironment = options.effigyEnvironment ?? process.env;
    this.effigyVersion = options.effigyVersion;
    assertHostRunStateDirSafe(
      this.dataDir,
      this.hostRunStateDir,
      process.env,
      options.testOnlyAllowLiveHostRunStateDir,
    );
    // Spec 028: the live store backs up to the configured work root; any other data
    // directory - a fixture, a private NUCLEUS_DATA_HOME instance - keeps its snapshots inside itself.
    // The rule lives in the backup worker, so the service and its children cannot disagree.
    initializeWorkRoot(this.dataDir);
    this.backupDir = backupDirForDataDir(this.dataDir);
    const scheduleBackups = options.timers !== false && !options.adapterFactory;
    const storePath = join(this.dataDir, "queue.sqlite");
    // A store that must migrate takes its snapshot and schema steps here; say so,
    // so the bridge waits for this start instead of spawning another beside it.
    this.spawnToken = process.env[SPAWN_TOKEN_ENV];
    let migrationStartedAt: number | null = null;
    this.store = new Store(storePath, this.backupDir, () => {
      migrationStartedAt = Date.now();
      markMigration(
        this.dataDir,
        process.pid,
        this.spawnToken,
        migrationStartedAt,
      );
    });
    this.capacityChanges = new CapacityChangeJournal(this.store);
    // Keyed mutations are journaled around their handlers so a replacement can
    // answer a response lost mid-roll (request ledger, service-boundary contract).
    this.requestLedger = new RequestLedger(this.store);
    // Spec 028: the one-shot conversion belongs to the production service. A fixture (timers
    // off, or a fixture adapter) only attempts it when it opts in, so no test rewrites a
    // store at start unless it is proving that path.
    const compactionOption:
      | false
      | {
          snapshot?: (path: string) => Promise<{ name: string; bytes: number }>;
        }
      | undefined = options.storeCompaction;
    const fixtureSnapshot = compactionOption
      ? compactionOption.snapshot
      : undefined;
    this.storeCompactionEnabled =
      compactionOption === false
        ? false
        : compactionOption
          ? true
          : options.timers !== false && !options.adapterFactory;
    this.compaction = new StoreCompactor(this.store, {
      snapshot: fixtureSnapshot
        ? () => fixtureSnapshot(this.store.path)
        : () => this.verifiedSnapshot(),
      freeBytes: () => freeBytesOn(this.store.path),
      log: (message) => console.error("Nucleus store maintenance:", message),
    });
    if (migrationStartedAt !== null)
      markMigration(
        this.dataDir,
        process.pid,
        this.spawnToken,
        migrationStartedAt,
        Date.now(),
      );
    this.hostRuns = HostRunScheduler.forStore(this.store);
    this.hostRuns.setLaunchPredicate(
      () => !this.closing && !this.idleShutdownLatched,
    );
    this.papercuts = new Papercuts(this.store);
    this.leads = new Leads(this.store);
    this.decisions = new Decisions(this.store);
    options.instrumentStore?.(this.store);
    const settingsPath = join(this.dataDir, "settings.json");
    if (!existsSync(settingsPath))
      writeFileSync(
        settingsPath,
        JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
        { mode: 0o600 },
      );
    this.settings =
      options.settings ??
      z
        .object({
          daemonUrl: z.string().url(),
          password: z.string().optional(),
          workRoot: z.string().optional(),
          workVolumeId: z.string().optional(),
          /** Effigy runtime settings: an optional `minVersion` floor. The retired exact-bytes pin parses and is ignored. */
          effigyRuntime: effigyRuntimeSettingsSchema.optional(),
          t3code: z
            .object({
              endpoint: z.string().url(),
              bearer: z.string().min(1),
              probeThreadId: z.string().min(1).optional(),
            })
            .optional(),
          uncertainMergeRetryMs: z
            .number()
            .int()
            .min(1)
            .max(UNCERTAIN_MERGE_PROOF_TIMEOUT_MS)
            .default(DEFAULT_UNCERTAIN_MERGE_RETRY_MS),
        })
        .parse(JSON.parse(readFileSync(settingsPath, "utf8")));
    if (
      !options.settings &&
      this.settings.t3code &&
      statSync(settingsPath).mode & 0o077
    )
      throw new Error("T3Code session settings must be owner-only (mode 600)");
    // Exactly one writable owner: a live previous owner fails closed here, so
    // an ambiguous database can never gain a second writer.
    this.store.transaction(() => {
      const previous = this.store.getMeta<{ pid: number; owner: string }>(
        "processOwner",
      );
      if (previous) {
        if (pidAlive(previous.pid))
          throw new Error("Another Nucleus backend still owns this database");
      }
      this.store.setMeta("processOwner", {
        pid: process.pid,
        owner: this.owner,
      });
      recordQaServiceLifecycle(this.store, "start");
    });
    this.hostRegistry = new HostRegistry(
      {
        read: () => this.store.getMeta<KnownHost[]>("hostRegistry") ?? [],
        write: (hosts) => this.store.setMeta("hostRegistry", hosts),
        transaction: (fn) => this.store.transaction(fn),
        readDisconnectedAt: () =>
          this.store.getMeta<number | null>("hostDisconnectedAt") ?? null,
        writeDisconnectedAt: (at) =>
          this.store.setMeta("hostDisconnectedAt", at),
        readLastSeen: () =>
          this.store.getMeta<Record<string, string>>("hostLastSeen") ?? {},
        writeLastSeen: (seen) => this.store.setMeta("hostLastSeen", seen),
      },
      options.hostNow ?? Date.now,
      options.hostIdleGraceMs ?? HOST_IDLE_GRACE_MS,
    );
    const createAdmission = () =>
      new Admission({
        ...options.admission,
        totalLimit: () => this.store.configuredPaseoCallLimit(),
        workspaceBudget: () =>
          this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT,
      });
    this.makeAdmission = createAdmission;
    // The ACP session surface is attached later in bootstrap (Spec 065), so the host
    // reads it through this getter rather than capturing it: a T3 parent thread is
    // minted from it and released through it (nucleus#1305).
    this.t3Host = this.settings.t3code
      ? new T3HostConnection(
          this.settings.t3code,
          this.dataDir,
          this.hostRegistry,
          createAdmission,
          undefined,
          () => this.engine.acp,
        )
      : null;
    this.t3Config = this.settings.t3code ?? null;
    this.t3SettingsStamp = settingsFileStamp(t3SettingsPath(this.dataDir));
    this.bbHost = new BbHostConnection(
      this.store,
      this.hostRegistry,
      createAdmission,
      this.dataDir,
    );
    const recordedHost = this.hostRegistry.primary()?.id;
    this.admission = recordedHost
      ? this.hostRegistry.resource(recordedHost, createAdmission)
      : createAdmission();
    if (options.adapterFactory) {
      const raw = options.adapterFactory({
        dataDir: this.dataDir,
        settings: this.settings,
      });
      raw.scratchNamespaceFor = (task) => this.store.scratchNamespaceFor(task);
      this.adapter = admitAdapter(raw, this.admission);
    } else {
      const hostHome = options.paseoHome ?? paseoHome();
      const sourcePath =
        options.sourcePath ??
        (compiledIdentity
          ? stableInstalledPath(sourcePathFromModule())
          : pluginRegistration(
              JSON.parse(readFileSync(join(hostHome, "config.json"), "utf8"))
                .plugins,
            )?.path);
      if (!sourcePath || !existsSync(join(sourcePath, "mcp-report.mjs")))
        throw new Error(
          "Installed plugin source is missing the MCP reporting bridge",
        );
      const raw = createHost(
        HostPolicies as unknown as HostPolicyConstructor,
        this.settings.daemonUrl,
        join(this.dataDir, "callback.sock"),
        join(this.dataDir, "worker-report.mjs"),
        this.settings.password,
        join(sourcePath, "mcp-report.mjs"),
      );
      raw.scratchNamespaceFor = (task) => this.store.scratchNamespaceFor(task);
      this.paseoAdapter = raw;
      this.adapter = admitAdapter(raw, this.admission);
    }
    this.runUsage = new RunUsageTracker(
      this.store,
      this.host,
      undefined,
      (run) => {
        if (!run.hostId || this.store.task(run.taskId).hostId !== run.hostId)
          return undefined;
        const adapter = this.hostRegistry.get(run.hostId)?.adapter;
        return adapter ? new HostFacade({ adapter }) : undefined;
      },
    );
    // Retired contract 009 producer: the runtime no longer observes durable writes for a
    this.engine = new Engine(
      this.store,
      this.adapter,
      60000,
      () => runtime.lifecycle.bootstrapCompleted && this.anyHostConnected(),
      undefined,
      this.settings.uncertainMergeRetryMs,
      this.hostRunStateDir,
    );
    this.engine.currentServiceBuildId = currentServiceBuildId;
    this.maintenance = new StoreMaintenance(
      this as unknown as StoreMaintenanceOwner,
    );
    this.hosts = new HostConnections(this as unknown as HostConnectionOwner);
    const runtime = this;
    wireEngineHosts(this.engine, {
      adapter: this.adapter,
      hostRegistry: this.hostRegistry,
      get hostSession() {
        return runtime.hostSession;
      },
      connected: () => runtime.connected(),
      store: this.store,
    });
    this.engine.siblingDataDir = this.dataDir;
    this.engine.setSourcePromotionHandler((payload, hostId, selection) =>
      this.executeSourcePromotion(payload, hostId, selection),
    );
    this.engine.setLeadCheckHandler((payload, operationId) =>
      this.executeLeadCheck(payload, operationId),
    );
    this.engine.setRepositoryRekeyHandler((input) => {
      const result = this.store.rekeyRepository(input);
      return {
        taskId: null,
        taskVersion: null,
        phase: null,
        number: null,
        reference: result.receipt.id,
      };
    });
    this.cachedTaskDetail = createTaskDetailCache(this.store, {
      slotAdmissionReason: (task) =>
        this.engine.resolution.slotAdmissionReason(task, true),
      externalWait: (task) => this.engine.queuedExternalWait(task),
      profiles: (task) => this.engine.profilesFor(task.hostId),
    });
    this.cachedTelemetrySnapshot = createTelemetrySnapshotCache(this.store);
    this.cachedUiSnapshotFacts = createUiSnapshotFactsCache(
      this.store,
      (tasks, runs) =>
        this.engine.resolution.slotAdmissionReader(tasks, runs, true),
      () => this.hostRuns.liveRuns(),
      (nowMs) =>
        this.store.qaBoardRuns(
          new Date(nowMs - QA_BOARD_PASS_FADE_MS).toISOString(),
        ),
      (task) => this.engine.queuedExternalWait(task),
      () => this.engine.queuedWaitSignature(),
      () =>
        this.hostSession?.id || this.hostRegistry.primary()?.id || "unknown",
    );
    this.questions = new RuntimeQuestions({
      store: this.store,
      engine: this.engine,
      decisions: this.decisions,
      markStoreAccess: () => this.markStoreAccess(),
    });
    this.settingsOperations = new RuntimeSettings({
      store: this.store,
      engine: this.engine,
      decisions: this.decisions,
      capacityChanges: this.capacityChanges,
      markStoreAccess: () => this.markStoreAccess(),
      connected: () => this.connected(),
      wakeAndSettlePostBootstrapTimeout: () =>
        this.wakeAndSettlePostBootstrapTimeout(),
      get started() {
        return runtime.started;
      },
      get hostId() {
        return (
          runtime.hostSession?.id ||
          runtime.hostRegistry.primary()?.id ||
          "host"
        );
      },
      get startError() {
        return runtime.startError;
      },
      get adapter() {
        return runtime.adapter;
      },
    });
    this.plannerTickets = new ParticipantTickets(this.engine, {
      socketPath: this.paseo.socketPath,
      helperPath: this.paseo.helperPath,
    });
    // Task 1109: a task planner's participant ticket is issued before the question
    // that names it, so `question.answer` works on a host without per-thread identity.
    this.engine.resolution.ensurePlannerTicket = (agentId, hostId) =>
      this.plannerTickets.ensureFor(agentId, hostId);
    this.engine.plannerTicketPending = () =>
      this.plannerTickets.pendingPlanners();
    this.repositories = new RuntimeRepositories({
      store: this.store,
      engine: this.engine,
      hostRuns: this.hostRuns,
      requiredCheckTransport: this.requiredCheckTransport,
      markStoreAccess: () => this.markStoreAccess(),
      projectQaRunner: () => this.projectQaRunner(),
      plannerChanged: (projectKey) => this.plannerTickets.assigned(projectKey),
      agentChanged: (projectKey, name, caller) =>
        this.plannerTickets.agentChanged(projectKey, name, caller),
      get started() {
        return runtime.started;
      },
    });
    this.planning = new RuntimePlanning({
      store: this.store,
      engine: this.engine,
      leads: this.leads,
      markStoreAccess: () => this.markStoreAccess(),
      get boardLeadsCache() {
        return runtime.boardLeadsCache;
      },
      set boardLeadsCache(value) {
        runtime.boardLeadsCache = value;
      },
      get started() {
        return runtime.started;
      },
      get host() {
        return runtime.host;
      },
    });
    this.board = new RuntimeBoard({
      store: this.store,
      engine: this.engine,
      decisions: this.decisions,
      cachedTaskDetail: this.cachedTaskDetail,
      cachedUiSnapshotFacts: this.cachedUiSnapshotFacts,
      markStoreAccess: () => this.markStoreAccess(),
      anyHostConnected: () => this.anyHostConnected(),
      backupHealthProjection: () => this.backupHealthProjection(),
      boardError: () => this.boardError(),
      get prStates() {
        return runtime.lifecycle.prStateMap();
      },
      get hostId() {
        return (
          runtime.hostSession?.id ||
          runtime.hostRegistry.primary()?.id ||
          "unknown"
        );
      },
    });
    this.lifecycle = new RuntimeLifecycle({
      store: this.store,
      engine: this.engine,
      adapter: this.adapter,
      admission: this.admission,
      hostRegistry: this.hostRegistry,
      plannerTickets: this.plannerTickets,
      t3Host: () => runtime.t3Host,
      refreshT3Settings: () => runtime.refreshT3Settings(),
      daemonUrl: this.settings.daemonUrl,
      connectTimeoutMs: this.connectTimeoutMs,
      readPrStates: (tasks) => readPrStates(tasks),
      get paseoHostId() {
        return runtime.paseoHostId;
      },
      get hostSession() {
        return runtime.hostSession;
      },
      set hostSession(value) {
        runtime.hostSession = value;
      },
      get idleShutdownLatched() {
        return runtime.idleShutdownLatched;
      },
      connected: () => runtime.connected(),
    });
    this.healthProjection = new RuntimeHealthProjection({
      store: this.store,
      engine: this.engine,
      lifecycle: this.lifecycle,
      hostRegistry: this.hostRegistry,
      t3Host: () => runtime.t3Host,
      bb: () => runtime.bbHost.status(),
      admission: this.admission,
      capacityChanges: this.capacityChanges,
      maintenance: this.maintenance,
      eventLoopDelay: this.eventLoopDelay,
      serveHostRunEndpoint: this.serveHostRunEndpoint,
      anyHostConnected: () => runtime.anyHostConnected(),
      drainProjection: () => runtime.drainProjection(),
      pluginPresenceFaultMessage: () => runtime.pluginPresenceFaultMessage(),
      hostSessionId: () => runtime.hostSession?.id ?? null,
      hostRunEndpoint: () => runtime.hostRunEndpoint,
      hostRunEndpointError: () => runtime.hostRunEndpointError,
      admissionRpcMetrics: () =>
        runtime.admissionEndpoint?.rpcMetrics() ?? null,
    });
    this.hostSettings = new HostCatalogueSettings({
      store: this.store,
      hostRegistry: this.hostRegistry,
      hostStates: () => runtime.healthProjection.hostStates(),
      bb: () => runtime.bbHost.status(),
      t3: () => runtime.t3Host?.status(),
      defaultHostKind: () =>
        runtime.capacityChanges.state().effective.operatorDefaultHostKind,
      forgetBb: (hostId) => runtime.bbHost.forget(hostId),
    });
    this.liveRunPresence = this.createLiveRunPresence();
    this.eventLoopDelay.start();
    if (options.timers !== false) {
      const tick = (withRefresh: boolean) => {
        if (this.closing) return;
        this.hostRuns.tick();
        // The endpoint is the first thing a serving process owes its clients; a
        // lost or refused bind must never wait for a request to be retried.
        void this.ensureHostRunEndpoint();
        // A milestone QA run survives a Queue roll in its detached supervisor
        // (task 114). Pick up any running run this process does not yet own, so
        // a restarted service settles it without waiting for a board read.
        void this.recoverProjectQa();
        if (this.anyHostConnected() && !this.store.getMeta("paused")) {
          this.scheduledQa ??= new ProjectQaSchedules(
            this.store,
            this.projectQaRunner(),
            { canAdmit: () => !this.closing && this.anyHostConnected() },
          );
          void this.scheduledQa.tick();
        }
        // Bootstrap in the background and never await it here. Awaiting it is what
        // wedged the runtime: one hung daemon call inside the shared bootstrap promise
        // stopped every tick from reaching its own sweep for thirteen minutes, with
        // health still reporting ready. The bootstrap reports its own failure, and the
        // sweep needs only the connection.
        void this.ensureBootstrap().catch(() => {});
        if (this.closing || !this.anyHostConnected()) return;
        this.engine.resumeSubmissions();
        // Spec 058 slice 1: open streams for new run agents and close settled ones. Local
        // bookkeeping plus at most one establishment call per new run; usage is never sampled.
        try {
          this.runUsage.sync();
        } catch {
          /* usage observation never blocks the sweep; the next tick retries */
        }
        // The sweep is one bounded cursor page, not a fleet pass: it yields, is
        // pre-empted by callbacks/controls/reads and eventually covers every missed
        // lifecycle signal. The slower profile refresh remains its own separate pass.
        const followUp =
          withRefresh && this.connected()
            ? this.refresh().then(() => this.engine.sweepOnce())
            : this.engine.sweepOnce();
        void followUp.catch((error) => {
          this.startError = String(error);
        });
      };
      // Callbacks and controls schedule their affected task immediately. This sweep is
      // the restart/missed-event safety net and the driver for steps that have no
      // callback of their own, and a tail step waits for one: at a minute per step a
      // closeout's seconds of work cost minutes of waiting. The pass stays bounded and
      // pre-emptible, so running it more often only tightens the net.
      this.timers.push(setInterval(() => tick(false), this.sweepIntervalMs));
      this.timers.push(
        setInterval(() => tick(true), PROFILE_REFRESH_INTERVAL_MS),
      );
      // Task 530: the live run set's tabs and labels reconcile on their own cadence,
      // faster than the lifecycle sweep and independent of it.
      this.liveRunPresence?.start(LIVE_RUN_PRESENCE_INTERVAL_MS);
      const retentionTimer = setInterval(
        () => {
          void (async () => {
            try {
              await this.store.pruneRetainedHistory();
            } catch {
              /* retried next hour */
            }
            // Milestone QA retention is its own owner now: settled checkouts and
            // expired per-run files age out here, never on a board read.
            try {
              await this.projectQaRunner().sweepRetention();
            } catch {
              /* retried next hour */
            }
            // Spec 028: freed pages are returned here, in one bounded pass, instead of growing
            // the file until the next full rewrite. A pass with nothing to release writes nothing.
            this.store.reclaimFreedPages();
          })();
        },
        60 * 60 * 1000,
      );
      retentionTimer.unref?.();
      this.timers.push(retentionTimer);
      if (scheduleBackups) {
        // Due against the newest verified snapshot, not this process's lifetime:
        // Queue rolls on every merge, so a per-lifetime interval could postpone
        // snapshots forever (review #570). A service start takes one only when due.
        const backupTimer = setInterval(
          () => this.backupIfDue(),
          BACKUP_DUE_CHECK_MS,
        );
        backupTimer.unref?.();
        this.timers.push(backupTimer);
      }
    }
    this.started = this.start();
    if (scheduleBackups)
      void this.started.then(() => this.backupIfDue()).catch(() => {});
  }

  private verifiedSnapshot(): Promise<{ name: string; bytes: number }> {
    return this.maintenance.verifiedSnapshot();
  }
  private backupIfDue(): void {
    this.maintenance.backupIfDue();
  }

  /**
   * The RPC handler's second slot is unused, so `backup.now` from Settings records a
   * manual snapshot; the schedule and the compaction route pass `automatic`. A press
   * while a scheduled snapshot runs joins that one, which stays unmarked.
   */
  backupNow(
    _input: Record<string, never> = {},
    origin: "manual" | "automatic" = "manual",
  ) {
    return this.maintenance.backupNow(_input, origin);
  }
  backupList(_input: Record<string, never> = {}) {
    return this.maintenance.backupList(_input);
  }

  /**
   * Spec 028: verified-snapshot health for the board projection. It is one directory
   * read and a small status file, refreshed on a bounded interval and as soon as a
   * snapshot settles, so no surface polls `backup.list` just to age a snapshot.
   */
  private backupHealthProjection(): import("../shared/contracts").BackupHealth {
    return this.maintenance.backupHealthProjection();
  }

  get paseoHostId(): string {
    return this.paseo.hostId;
  }
  private connected(): boolean {
    return this.hosts.connected();
  }
  private anyHostConnected(): boolean {
    return this.hosts.anyHostConnected();
  }

  /**
   * Adopt a connection the operator route just wrote, or dropped, without a
   * restart (nucleus#1330). The settings file's stamp decides whether there is
   * anything to read, so an ordinary bootstrap tick costs one stat; a changed
   * `t3code` block closes the previous connection's claim and builds the one the
   * file now names. A malformed block changes nothing: the connection that is
   * working keeps working until the file is fixed.
   */
  refreshT3Settings(): void {
    if (this.closing) return;
    const path = t3SettingsPath(this.dataDir);
    const stamp = settingsFileStamp(path);
    if (stamp === this.t3SettingsStamp) return;
    this.t3SettingsStamp = stamp;
    let next: T3ConnectionConfig | null;
    try {
      next = readT3Connection(this.dataDir);
    } catch (error) {
      console.error(
        "T3Code settings reload refused:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (sameT3Connection(next, this.t3Config)) return;
    let replacement: T3HostConnection | null = null;
    if (next) {
      try {
        replacement = new T3HostConnection(
          next,
          this.dataDir,
          this.hostRegistry,
          this.makeAdmission,
          undefined,
          () => this.engine.acp,
        );
      } catch (error) {
        console.error(
          "T3Code connection refused:",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    this.t3Config = next;
    this.t3Host?.close();
    this.t3Host = replacement;
    if (!this.t3Host) return;
    void this.t3Host.ensureConnected().catch(() => {
      /* the next bootstrap tick reconnects; health reports the failure */
    });
  }

  /** A lost host connection is not evidence that any host run ended. */
  hostShutdownDue(): boolean {
    return this.hosts.hostShutdownDue();
  }
  cancelHostShutdown() {
    this.hosts.cancelHostShutdown();
  }
  hostPresenceClosed() {
    this.hosts.hostPresenceClosed();
  }
  hostPresenceOpened() {
    this.hosts.hostPresenceOpened();
  }

  /**
   * A BB plugin proved its identity through the host-operation channel (Spec 062,
   * phase 1). The runtime is the authority on the recorded data directory: the same
   * one re-registers, a different one refuses by its field with nothing registered.
   */
  bbHostVerified(input: BbHostVerifiedInput) {
    return this.bbHost.verified(input);
  }
  /** Record BB's operator-authored presentation parent for one Nucleus thread. */
  bbParentChanged(input: unknown): { ok: true; matched: boolean } {
    const value = input as {
      hostId?: unknown;
      threadId?: unknown;
      parentThreadId?: unknown;
      at?: unknown;
    };
    if (
      typeof value?.hostId !== "string" ||
      typeof value.threadId !== "string" ||
      !(
        value.parentThreadId === null ||
        typeof value.parentThreadId === "string"
      ) ||
      typeof value.at !== "string"
    )
      return { ok: true, matched: false };
    const taskId = recordBbPresentationParentChange(
      this.store,
      value.hostId,
      value.threadId,
      value.parentThreadId as string | null,
      value.at,
    );
    if (!taskId) return { ok: true, matched: false };
    void this.engine.wakeTask(taskId);
    return { ok: true, matched: true };
  }
  /** A declaration or probe left the identity unproven: the host is offline for the named reason. */
  bbHostRejected(input: BbHostRejectedInput) {
    this.bbHost.rejected(input);
  }
  /** The executor connection closed: this identity's claim retires unless a reload replaced it. */
  bbHostReleased(input: BbHostReleasedInput) {
    this.bbHost.released(input);
  }
  /** One liveness heartbeat from the registered executor's own connection. */
  bbHostHeartbeat(input: { hostId: string; at: string }) {
    this.bbHost.heartbeat(input.hostId, input.at);
  }
  /** Spec 065: mint a task's ACP session and the owner-only pointer in its checkout. */
  bindAcpSession(input: { taskId: string }) {
    return bindAcpSession(this.engine.acp, input);
  }

  private clearPluginPresenceWatch() {
    this.hosts.clearPluginPresenceWatch();
  }
  private pluginPresenceFaultMessage(): string {
    return this.hosts.pluginPresenceFaultMessage();
  }
  private boardError(): string {
    return (
      this.startError ||
      this.store.getMeta<string>("engineError") ||
      this.store.getMeta<string>("retentionError") ||
      this.store.getMeta<string>("laneIdleError") ||
      this.store.getMeta<string>("laneDrainError") ||
      this.pluginPresenceFaultMessage() ||
      ""
    );
  }

  private get paseo(): Adapter &
    RegistrationAdapter & { socketPath: string; helperPath: string } {
    return this.adapter as Adapter &
      RegistrationAdapter & { socketPath: string; helperPath: string };
  }

  private markStoreAccess() {
    this.lifecycle.markStoreAccess();
  }

  /** One catalog refresh; the lifecycle owns the pass, its coalescing and its typed facts. */
  refresh(): Promise<void> {
    return this.lifecycle.refresh();
  }

  private async start(): Promise<void> {
    this.lifecycle.beginStart();
    // Spec 028: a store that still says `auto_vacuum=0` is converted here, before the
    // service binds anything or releases work. This is the one window in which no Queue
    // writer can be in flight: the conversion's own quiet gate still proves the file is
    // unheld and refuses to touch it otherwise, and a refusal or failure is recorded and
    // reported without holding readiness (bounded by its own estimated blocked interval).
    if (this.storeCompactionEnabled) {
      // The window is admitted durably and bounded before it runs, so the roll that spawned
      // this service waits for it by its own marker and caps instead of mistaking it for a
      // hung start (and instead of starting a second replacement beside it). A refusal, a
      // failure or a landed-but-unverified rewrite is recorded in the store and never throws
      // out of here: the store stays usable.
      const maintenanceStartedAt = Date.now();
      markMaintenance(
        this.dataDir,
        process.pid,
        this.spawnToken,
        maintenanceStartedAt,
      );
      try {
        const run = await this.compaction.runIfDue("service-start");
        if (run?.converted) this.maintenance.clearBoardBackup();
        if (
          run &&
          run.record.state !== "converted" &&
          run.record.state !== "refused"
        )
          console.error(
            `Nucleus store maintenance: ${run.record.state}: ${run.record.reason ?? "no reason recorded"}`,
          );
      } catch (error) {
        console.error(
          "Nucleus store maintenance:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        markMaintenance(
          this.dataDir,
          process.pid,
          this.spawnToken,
          maintenanceStartedAt,
          Date.now(),
        );
      }
    }
    try {
      if (this.serveHostRunEndpoint) {
        // Bound first, ahead of callbacks: a service roll's contract-010 reconnect
        // window is 5 s, so the endpoint is the first thing the new owner serves.
        // Contract 010's client-protocol v1 socket. A failure here is reported but
        // never blocks Queue readiness: the scheduler keeps scheduling, and a
        // heavy client fails closed (code 75) while the endpoint is unreachable.
        try {
          this.hostRunEndpoint = new HostRunEndpoint(this.hostRuns, {
            stateDir: this.hostRunStateDir,
            ...(this.hostRunFront ? { front: this.hostRunFront } : {}),
          });
          await this.hostRunEndpoint.start();
          this.hostRunEndpointError = "";
          this.admissionEndpoint = new EffigyAdmissionEndpoint(this.hostRuns, {
            stateDir: this.hostRunStateDir,
            // Spec 035 "Runtime identity": the workload's own Effigy, found from
            // its attested ancestry, is bound and observes its run; settings carry
            // only an optional minVersion floor.
            effigyRuntime: this.settings.effigyRuntime ?? null,
            environment: this.effigyEnvironment,
            ...(this.effigyVersion
              ? { effigyVersion: this.effigyVersion }
              : {}),
          });
          try {
            await this.admissionEndpoint.start();
          } catch (error) {
            console.error(
              "Nucleus admission endpoint:",
              error instanceof Error ? error.message : String(error),
            );
          }
        } catch (error) {
          // Keep the instance: a bind refused by a live holder (or another
          // transient failure) is retried by maintenance, so the process serving
          // `queue-service.sock` never stays silently without the endpoint.
          this.hostRunEndpointError =
            error instanceof Error ? error.message : String(error);
          this.startError = `Host-run endpoint: ${this.hostRunEndpointError}`;
          console.error("Nucleus host-run endpoint:", this.startError);
        }
        let hookCommand: string;
        try {
          hookCommand = defaultAdmissionHookCommand();
        } catch (error) {
          // Missing tsx must not abort Queue start. A deny stub keeps v0.15
          // fail-closed instead of running heavy work with no hook.
          console.error(
            "Nucleus admission hook command:",
            error instanceof Error ? error.message : String(error),
          );
          hookCommand = "printf 'deny Queue admission hook is unavailable\\n'";
        }
        this.paseoAdapter?.setAdmissionLaunchEnv(
          queueOwnedAdmissionEnvironment({
            hookCommand,
            socketPath: hostRunAdmissionSocketPath(this.hostRunStateDir),
          }),
        );
      }
    } finally {
      this.resolveHostRunReady();
    }
    try {
      this.closeCallbacks = await startCallbacks(
        this.paseo.socketPath,
        this.paseo.helperPath,
        this.engine,
      );
    } catch (error) {
      // A callback-surface failure is local and real; it latches like the legacy
      // startup error and the periodic timer keeps retrying the daemon side.
      this.startError = error instanceof Error ? error.message : String(error);
      console.error("Nucleus startup:", this.startError);
      this.lifecycle.markReady();
      return;
    }
    // Spec 065: an ACP binding points at that callback socket, so the session
    // surface is attached only once the socket it names is served.
    this.engine.acp = new AcpSessions(this.engine, {
      dataHome: this.dataDir,
      socketPath: this.paseo.socketPath,
    });
    // Local reads are safe as soon as the callback surface and SQLite owner
    // exist. Daemon connection, profile refresh, durable operation resume and
    // the first reconciliation sweep continue in the background.
    this.lifecycle.markReady();
    // The daemon connect is bounded, but it never abandons the rest of
    // bootstrap: when it settles — immediately or on a later retry — the
    // identity check, catalog refresh and durable-operation resume all run.
    this.lifecycle.startBootstrap();
  }

  /**
   * Maintenance self-heal for the host-run endpoint (Spec 035, "Endpoint across a
   * roll"). The process serving `queue-service.sock` binds the endpoint when it
   * has none and `authority.json` names a dead holder; a live holder is never
   * taken over and this process reports itself unhealthy instead. A socket this
   * endpoint bound and later lost is handled by the endpoint's own maintenance.
   */
  async ensureHostRunEndpoint(): Promise<void> {
    if (!this.serveHostRunEndpoint || this.closing || !this.hostRunEndpoint)
      return;
    const serving = await this.hostRunEndpoint.ensureServing();
    const previous = this.hostRunEndpointError;
    this.hostRunEndpointError = serving
      ? ""
      : (this.hostRunEndpoint.error() ?? "");
    if (this.hostRunEndpointError && this.hostRunEndpointError !== previous) {
      this.startError = `Host-run endpoint: ${this.hostRunEndpointError}`;
      console.error("Nucleus host-run endpoint:", this.hostRunEndpointError);
    }
    if (
      !this.hostRunEndpointError &&
      previous &&
      this.startError === `Host-run endpoint: ${previous}`
    ) {
      this.startError = "";
    }
  }

  /**
   * One bounded connect plus the full post-connect bootstrap, retried by the
   * periodic timers and by queue.refresh, so a transient daemon outage at
   * startup (or later) resumes reconciliation and accepted durable operations
   * without an operator action.
   */
  ensureBootstrap(): Promise<boolean> {
    return this.lifecycle.ensureBootstrap();
  }

  /** A completed full wake can settle an older post-bootstrap timeout diagnostic. */
  private wakeAndSettlePostBootstrapTimeout(): Promise<void> {
    return this.lifecycle.wakeAndSettlePostBootstrapTimeout();
  }

  /** This runtime's facts, presented by the single health projection owner. */
  health(): RuntimeHealth {
    return this.healthProjection.health();
  }

  /**
   * Drain to a durable safe point and release every owned resource.
   *
   * Every phase is bounded: a service that started while the Paseo SDK cannot
   * settle (or whose engine will not quiesce) must still release the socket,
   * identity, durable process lease and SQLite store, so replacement and
   * rollback never hang on an unreachable daemon (Contract 007).
   */
  async drain(): Promise<void> {
    if (this.closing) return;
    this.lifecycle.beginDrain();
    this.clearPluginPresenceWatch();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.eventLoopDelay.stop();
    this.liveRunPresence?.stop();
    this.hostRuns.stop();
    this.maintenance.abort();
    this.engine.stopped = true;
    const settled = (
      promise: Promise<unknown> | undefined | null,
      ms: number,
    ) =>
      Promise.race([
        Promise.resolve(promise).then(
          () => undefined as undefined,
          () => undefined as undefined,
        ),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), ms);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    try {
      this.t3Host?.close();
      await settled(
        (this.adapter as unknown as { close?(): Promise<void> }).close?.(),
        5_000,
      );
      await settled(this.started, 10_000);
      await settled(this.maintenance.running, 5_000);
      await settled(this.lifecycle.pendingRefresh, 5_000);
      // Bounded quiesce: an effect still in flight when the bound fires is
      // abandoned here, never killed or reissued; every such effect keeps its
      // stored durable intent and is reconciled by its own gates on the next
      // start (durable operations, disposition fences and restart recovery),
      // which is what lets the lease always release.
      await settled(this.engine.stop(), 10_000);
      await settled(this.closeCallbacks?.(), 5_000);
      await settled(this.hostRunEndpoint?.stop(), 5_000);
      await settled(this.admissionEndpoint?.stop(), 5_000);
    } finally {
      this.runUsage.close();
      if (
        this.store.getMeta<{ owner: string }>("processOwner")?.owner ===
        this.owner
      )
        this.store.deleteMeta("processOwner");
      this.store.close();
      this.lifecycle.markStopped();
    }
  }

  /** Legacy alias for the historical stop export. */
  stop(): Promise<void> {
    return this.drain();
  }

  snapshot(input: SnapshotInput = {}): SnapshotState {
    return this.board.snapshot(input);
  }
  uiSnapshot(
    input: { revision?: number } = {},
  ): import("../shared/contracts").UiBoard {
    return this.board.uiSnapshot(input);
  }
  /**
   * Spec 062 decision 5b: the forked sidebar's one batched read. Live tasks joined
   * to their recorded BB workspace handles through the task's own workspace id, so
   * the answer carries every Nucleus task group at once and no group costs a call.
   */
  bbSidebarGroups(): BbSidebarGroups {
    return this.board.sidebarGroups();
  }
  queuedPage(input: { repoPath: string; offset: number; limit: number }) {
    return this.board.queuedPage(input);
  }
  laneTaskPage(input: { lane: string; offset: number; limit: number }) {
    return this.board.laneTaskPage(input);
  }
  detail(input: {
    taskId?: string;
    reference?: string;
    repository?: string;
    number?: number;
  }) {
    return this.board.detail(input);
  }
  taskNext(input: {
    taskId?: string;
    reference?: string;
    caller?: "operator (board)";
  }) {
    return this.board.taskNext(input);
  }
  outcome(input: {
    taskId?: string;
    submissionId?: string;
    reference?: string;
    repository?: string;
    number?: number;
  }) {
    return this.board.outcome(input);
  }
  outcomeSearch(input: OutcomeSearchInput) {
    return this.board.outcomeSearch(input);
  }
  private drainProjection(): { drained: boolean; boundRuns: BoundRun[] } {
    return this.board.drainProjection();
  }

  addPapercut(input: Parameters<Papercuts["add"]>[0]) {
    return this.papercuts.add(input);
  }
  listPapercuts(input: { repository?: string; state?: Papercut["state"] }) {
    return this.papercuts.list(input);
  }
  getPapercut(input: { id: string }) {
    return this.papercuts.get(input);
  }
  editPapercut(input: Parameters<Papercuts["edit"]>[0]) {
    return this.papercuts.edit(input);
  }
  promotePapercut(input: Parameters<Papercuts["promote"]>[0]) {
    return this.papercuts.promote(input);
  }
  closePapercut(input: Parameters<Papercuts["close"]>[0]) {
    return this.papercuts.close(input);
  }
  setPapercutLanes(input: Parameters<Papercuts["setLanes"]>[0]) {
    return this.papercuts.setLanes(input);
  }
  async addLead(input: Parameters<Leads["add"]>[0]) {
    return this.planning.addLead(input);
  }
  async editLead(input: Parameters<Leads["edit"]>[0]) {
    return this.planning.editLead(input);
  }
  getLead(input: Parameters<Leads["get"]>[0]) {
    return this.planning.getLead(input);
  }
  getLeadSummary(input: Parameters<Leads["getSummary"]>[0]) {
    return this.planning.getLeadSummary(input);
  }
  getLeadVersion(input: Parameters<Leads["getVersion"]>[0]) {
    return this.planning.getLeadVersion(input);
  }
  listLeads(input: Parameters<Leads["list"]>[0]) {
    return this.planning.listLeads(input);
  }
  leadBoard() {
    return this.planning.leadBoard();
  }
  setLeadLanes(input: Parameters<Leads["setLanes"]>[0]) {
    return this.planning.setLeadLanes(input);
  }
  setLeadTags(input: Parameters<Leads["setTags"]>[0]) {
    return this.planning.setLeadTags(input);
  }
  dropLead(input: Parameters<Leads["drop"]>[0]) {
    return this.planning.dropLead(input);
  }
  reopenLead(input: Parameters<Leads["reopen"]>[0]) {
    return this.planning.reopenLead(input);
  }
  promoteLead(input: Parameters<Leads["promote"]>[0]) {
    return this.planning.promoteLead(input);
  }
  async checkLead(
    input: { id: string; repository?: string; baseBranch?: string },
    acceptance = true,
  ) {
    return this.planning.checkLead(input, acceptance);
  }
  private async executeLeadCheck(
    payload: unknown,
    operationId: string,
  ): Promise<OperationResult> {
    return this.planning.executeLeadCheck(payload, operationId);
  }
  submitLead(input: Parameters<RuntimePlanning["submitLead"]>[0]) {
    return this.planning.submitLead(input);
  }
  approveLead(input: {
    id: string;
    version: number;
    digest: string;
    approver: string;
    note: string;
    relayed: boolean;
  }) {
    return this.planning.approveLead(input);
  }
  promoteLeadToTask(input: {
    id: string;
    repository?: string;
    baseBranch?: string;
    agent?: string;
    note: string;
    board: boolean;
    hold?: { reason: string; until?: string };
    identitySource?: IdentitySource;
  }) {
    return this.planning.promoteLeadToTask(input);
  }
  promotePapercutToTask(input: {
    id: string;
    repository?: string;
    baseBranch?: string;
    agent?: string;
    note: string;
    board: boolean;
    hold?: { reason: string; until?: string };
    complexity?: z.infer<typeof sourcePromotionInputSchema>["complexity"];
  }) {
    return this.planning.promotePapercutToTask(input);
  }
  private async executeSourcePromotion(
    payload: unknown,
    hostId?: string,
    selection?: import("../shared/operations").QueueOperation["hostSelection"],
  ): Promise<OperationResult> {
    return this.planning.executeSourcePromotion(payload, hostId, selection);
  }
  importLeads(input: Parameters<Leads["import"]>[0]) {
    return this.planning.importLeads(input);
  }
  addDecision(input: Parameters<Decisions["add"]>[0]) {
    return this.questions.addDecision(input);
  }
  backfillDecisions(input: { dryRun?: boolean }) {
    return this.questions.backfillDecisions(input);
  }
  getDecision(input: Parameters<Decisions["get"]>[0]) {
    return this.questions.getDecision(input);
  }
  listDecisions(input: Parameters<Decisions["list"]>[0]) {
    return this.questions.listDecisions(input);
  }
  decisionAgentProjects(input: Parameters<Decisions["agentProjects"]>[0]) {
    return this.questions.decisionAgentProjects(input);
  }
  async listNativeQuestions(input: {
    taskId: string;
    agentId?: string;
    agentRef?: string;
  }) {
    return this.questions.listNativeQuestions(input);
  }
  async answerNativeQuestion(input: {
    taskId: string;
    agentId?: string;
    agentRef?: string;
    requestId: string;
    answers: Record<string, string>;
  }) {
    return this.questions.answerNativeQuestion(input);
  }
  answerHostPermission(
    input: import("../shared/rpc/questions").HostPermissionAnswerInput,
  ) {
    return answerHostPermission(this.hostRegistry, input, {
      store: this.store,
      attention: (task, reason) =>
        this.engine.withHost(task.hostId, () =>
          this.engine.resolution.attention(task, reason, "uncertain_delivery"),
        ),
    });
  }
  answerDelegatedQuestion(
    input: import("../shared/contracts").QuestionAnswerRequest,
  ) {
    return this.questions.answerDelegatedQuestion(input);
  }
  answerDecision(input: Parameters<Decisions["answer"]>[0]) {
    return this.questions.answerDecision(input);
  }
  withdrawDecision(input: Parameters<Decisions["withdraw"]>[0]) {
    return this.questions.withdrawDecision(input);
  }
  linkDecision(input: Parameters<Decisions["link"]>[0]) {
    return this.questions.linkDecision(input);
  }
  supersedeDecision(input: Parameters<Decisions["supersede"]>[0]) {
    return this.questions.supersedeDecision(input);
  }
  getLaneDocument(input: { key: string; version?: number }) {
    return this.planning.getLaneDocument(input);
  }
  editLaneDocument(input: Parameters<Store["editLaneDocument"]>[0]) {
    return this.planning.editLaneDocument(input);
  }
  getPlan(input: Parameters<Store["plan"]>[0]) {
    return this.planning.getPlan(input);
  }
  listPlans() {
    return this.planning.listPlans();
  }
  setPlan(input: Parameters<Store["setPlan"]>[0]) {
    return this.planning.setPlan(input);
  }

  async telemetry(input: unknown) {
    const snapshot = await this.cachedTelemetrySnapshot(input);
    // Existing telemetry gains Queue's own outbound admission and sweep evidence
    // without changing any lifecycle measurement.
    return {
      ...snapshot,
      admission: this.admission.snapshot(),
      reconciliation: this.engine.reconciliationSnapshot(),
      controls: taskControlTelemetry(this.store, input),
    };
  }

  /**
   * Bounded Paseo lifecycle hint from the thin bridge (Contract 007). It maps
   * only identities Queue already knows to their dirty task lanes, ignores an
   * unknown identity without a fleet scan, and never performs delivery work.
   */
  lifecycleSignal(input: unknown): LifecycleSignalReceipt {
    const parsed = lifecycleSignalSchema.safeParse(input);
    if (!parsed.success) return { ok: true, matched: 0 };
    const signal: LifecycleSignal = parsed.data;
    this.admission.noteLifecycleSignal({
      agentId: signal.agentId,
      workspaceId: signal.workspaceId,
    });
    // Audit A6: the pass re-reads a retired worker this signal names instead of
    // waiting out its slow cadence. The hint stays a scheduling hint only.
    // This owner-only socket does not authenticate the originating host. The
    // hint may wake an unambiguous identity but cannot claim a host context.
    this.engine.noteLifecycleSignal(signal);
    const taskIds = this.store.taskIdsForIdentities({
      agentId: signal.agentId,
      workspaceId: signal.workspaceId,
    });
    for (const taskId of taskIds) void this.engine.wakeTask(taskId);
    return { ok: true, matched: taskIds.length };
  }

  /**
   * The bridge is replacing this service after a checkout change. A detached
   * validation supervisor records its result independently; if it ends without
   * one, Queue reconciles a safe hold and requires explicit resubmission.
   */
  /** Operator diagnostic: a bounded CPU profile of this runtime thread, written under the data dir. */
  async cpuProfile(
    input: unknown,
  ): Promise<{ path: string; seconds: number; nodes: number }> {
    const seconds =
      typeof (input as { seconds?: unknown } | null)?.seconds === "number"
        ? (input as { seconds: number }).seconds
        : 10;
    return captureCpuProfile(join(this.dataDir, "profiles"), seconds);
  }

  recordServiceRoll(input: unknown): { recorded: number } {
    recordQaServiceLifecycle(this.store, "roll");
    const roll = input as { fromBuild?: unknown; toBuild?: unknown } | null;
    const from = String(roll?.fromBuild ?? "unknown").slice(0, 64),
      to = String(roll?.toBuild ?? "unknown").slice(0, 64);
    let recorded = 0;
    for (const task of this.store.tasks()) {
      if (task.resolution.projectValidation?.state !== "running") continue;
      this.store.event(
        task.id,
        "service_roll",
        `Queue service rolling ${from} → ${to} after a checkout change; project validation reconciles from its durable supervisor result`,
      );
      recorded++;
    }
    return { recorded };
  }

  /** The recovery read behind `service.request-outcome`: what happened to one keyed request. */
  requestOutcome(input: unknown): {
    status: string;
    result?: unknown;
    truncated?: true;
    code?: string;
    message?: string;
  } {
    const key =
      typeof (input as { key?: unknown } | null)?.key === "string"
        ? (input as { key: string }).key
        : "";
    if (!key) return { status: "not_received" };
    return this.requestLedger.outcome(key);
  }

  /**
   * Legacy synchronous submission surface. Acceptance is durable before any git,
   * origin or hook validation; the historical Task result is preserved only while
   * the operation settles inside the bounded compatibility window. A slower or
   * uncertain command returns its explicit accepted operation identity instead of
   * an unknown timeout, and a retry reconciles the same submission operation.
   */
  async submit(
    input: Submission,
  ): Promise<import("../shared/contracts").Task | OperationAcceptance> {
    await this.started;
    this.requireComplexityOnFirstAcceptance(
      input,
      `submit:${input.submissionId}`,
    );
    const acceptance = await this.engine.startSubmission(input);
    if ("backpressured" in acceptance) return acceptance;
    const operation = await this.engine.awaitOperation(acceptance.operation.id);
    if (operation.state === "succeeded" && operation.result?.taskId)
      return this.store.task(operation.result.taskId);
    if (operation.state === "failed")
      throw new Error(operation.diagnostic || "Submission operation failed");
    return { accepted: true, operation };
  }
  private requireComplexityOnFirstAcceptance(
    submission: { complexity?: Submission["complexity"] },
    key: string,
  ) {
    return this.planning.requireComplexityOnFirstAcceptance(submission, key);
  }

  /** Strict generic durable operation start; never waits for completion. */
  async operationStart(
    input: z.infer<typeof import("../shared/contracts").operationStart.input>,
  ) {
    await this.started;
    if (input.kind === "submit")
      this.requireComplexityOnFirstAcceptance(
        (
          input.payload as {
            submission?: { complexity?: Submission["complexity"] };
          }
        ).submission ?? {},
        input.key,
      );
    // A review entry binds a new task too, whose reviewer and coordinator runs have a demand.
    if (input.kind === "review_entry")
      this.requireComplexityOnFirstAcceptance(
        (
          input.payload as {
            input?: { submission?: { complexity?: Submission["complexity"] } };
          }
        ).input?.submission ?? {},
        input.key,
      );
    if (input.kind === "source_promote")
      throw new Error(
        "Use lead.promote-task or papercut.promote-task to start a source promotion",
      );
    if (input.kind !== "submit" && !this.anyHostConnected())
      throw new Error(this.startError || "All hosts are disconnected");
    if (input.kind !== input.payload.type)
      throw new Error("Operation kind must match its payload type");
    const requestedHost =
      input.payload.type === "submit"
        ? input.payload.submission.hostId
        : input.payload.type === "review_entry"
          ? input.payload.input.submission.hostId
          : undefined;
    if (input.hostId && requestedHost && input.hostId !== requestedHost)
      throw new Error("Operation host conflicts with submission host");
    const payload = input.payload;
    return this.engine.startOperation({
      key: input.key,
      kind: input.kind,
      payload,
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      repoPath: input.repoPath,
      submissionId: input.submissionId,
      hostId:
        input.hostId ??
        (input.payload.type === "submit"
          ? input.payload.submission.hostId
          : input.payload.type === "review_entry"
            ? input.payload.input.submission.hostId
            : undefined),
    });
  }

  /** Inspect one operation, reconciling a proven historical pre-send refusal without executing it. */
  operationStatus(input: {
    operationId: string;
    reconcilePreSendInputHash?: string;
  }) {
    return input.reconcilePreSendInputHash === undefined
      ? this.engine.operationStatus(input.operationId)
      : this.store.reconcileTaskControlPreSend(
          input.operationId,
          input.reconcilePreSendInputHash,
        );
  }

  async reviewEntryWorkspace(
    input: import("../shared/contracts").ReviewEntryWorkspaceInput,
  ) {
    await this.started;
    if (!this.anyHostConnected())
      throw Error(this.startError || "All hosts are disconnected");
    const hostId = this.engine.selectIngressHost(input.hostId, input.repoPath);
    if (
      !hostId ||
      !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))
    )
      throw Error("Selected review-entry host is unavailable");
    return this.engine.withHost(hostId, async () => {
      const created = await prepareReviewEntryWorkspace(
        this.engine.adapter,
        input,
      );
      return { workspaceId: created.id };
    });
  }

  async reviewEntryPreview(input: ReviewEntryInput) {
    await this.started;
    if (!this.anyHostConnected())
      throw Error(this.startError || "All hosts are disconnected");
    const hostId = this.engine.selectIngressHost(
      input.submission.hostId,
      input.submission.repoPath,
    );
    if (
      !hostId ||
      !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))
    )
      throw Error("Selected review-entry host is unavailable");
    return this.engine.withHost(hostId, async () => {
      const adapter = this.engine.adapter as Adapter & ReviewEntryAdapter;
      if (!adapter.inspectReviewEntry || !adapter.originAgent)
        throw Error("Review entry is unavailable on this adapter");
      const routingConflict = this.engine.independentReviewRoutingRefusal({
        ...input.submission,
        declaredAuthorModels: input.authorDeclaration.models,
      });
      if (routingConflict)
        return {
          eligible: false as const,
          refusals: [
            {
              code: "author_identity_unverified" as const,
              explanation: routingConflict,
            },
          ],
          pendingHandover: null,
          resolved: null,
        };
      const originHost = await this.engine.identifyOriginHost(
        input.submission.originAgentId,
        input.submission.originIdentity,
      );
      if (!originHost)
        throw Error("Review-entry origin host is unknown or ambiguous");
      if (originHost === hostId)
        return previewReviewEntry(this.store, adapter, input);
      const proof = await originReviewProof(
        this.engine.host,
        this.engine.withHost.bind(this.engine),
        originHost,
        input.submission.originAgentId,
      );
      return previewReviewEntry(
        this.store,
        withOriginReviewAdapter(adapter, (reviewInput, taskId) =>
          adapter.inspectReviewEntry(reviewInput, taskId, proof),
        ),
        input,
      );
    });
  }

  /** Explicit operator rearm of one attention-held review-entry operation; never a generic reset. */
  async reviewEntryReconcile(
    input: z.infer<typeof reviewEntryReconcileInputSchema>,
  ) {
    await this.started;
    if (!this.anyHostConnected())
      throw Error(this.startError || "All hosts are disconnected");
    const selectedHost = this.store.operation(input.operationId)?.hostId;
    if (
      !selectedHost ||
      !this.engine.withHost(selectedHost, () =>
        this.engine.hostAvailable(selectedHost),
      )
    )
      throw Error("Review entry is waiting for its recorded host");
    const { operation, reopened } = await this.engine.withHost(
      selectedHost,
      async () => {
        const adapter = this.engine.adapter as Adapter & ReviewEntryAdapter;
        if (!adapter.inspectReviewEntry || !adapter.originAgent)
          throw Error("Review entry is unavailable on this adapter");
        const payload = this.store.operationPayload(input.operationId) as {
          input?: ReviewEntryInput;
        };
        const originId = payload.input?.submission.originAgentId;
        const originHost = originId
          ? await this.engine.identifyOriginHost(
              originId,
              payload.input?.submission.originIdentity,
            )
          : undefined;
        if (!originHost || !originId)
          throw Error("Review-entry origin host is unknown or ambiguous");
        if (originHost === selectedHost)
          return reconcileReviewEntryOperation(
            this.store,
            adapter,
            input.operationId,
            input.inputHash,
          );
        const proof = await originReviewProof(
          this.engine.host,
          this.engine.withHost.bind(this.engine),
          originHost,
          originId,
        );
        return reconcileReviewEntryOperation(
          this.store,
          withOriginReviewAdapter(adapter, (reviewInput, taskId) =>
            adapter.inspectReviewEntry(reviewInput, taskId, proof),
          ),
          input.operationId,
          input.inputHash,
        );
      },
    );
    if (reopened) this.engine.scheduleAcceptedOperation(operation.id);
    return operation;
  }

  async submitInstruction(input: z.infer<typeof submitInstructionRpc.input>) {
    return this.submit(
      submissionSchema.parse({
        ...input,
        handoffPath: input.instruction.path,
        planningCommit: input.instruction.commit,
      }),
    );
  }
  configurePool({ entries }: { entries: PoolEntry[] }) {
    return this.settingsOperations.configurePool({ entries });
  }
  configureProfile(settings: ProfileSettings) {
    return this.settingsOperations.configureProfile(settings);
  }
  profileList() {
    return this.settingsOperations.profileList();
  }
  profileCreate(
    input: z.infer<
      typeof import("../shared/contracts").createNucleusProfile.input
    >,
  ) {
    return this.settingsOperations.profileCreate(input);
  }
  profileUpdate(
    input: z.infer<
      typeof import("../shared/contracts").updateNucleusProfile.input
    >,
  ) {
    return this.settingsOperations.profileUpdate(input);
  }
  profileRemove(input: { id: string }) {
    return this.settingsOperations.profileRemove(input);
  }
  profileVocabulary(input: { cwd?: string; refresh?: boolean }) {
    return this.settingsOperations.profileVocabulary(input);
  }
  profileCompatibility() {
    return this.settingsOperations.profileCompatibility();
  }
  async hostCatalog(input: { cwd?: string; refresh?: boolean }) {
    return this.settingsOperations.hostCatalog(input);
  }
  queueControl({
    paused,
    dispatchHeld,
  }: {
    paused?: boolean;
    dispatchHeld?: boolean;
  }) {
    return this.settingsOperations.queueControl({ paused, dispatchHeld });
  }

  /**
   * Queue #650: the operator's stop-every-active-thread control. One service
   * method for the board and the CLI; refused unless Queue is paused. Every
   * live Queue-owned turn is cancelled through the existing durable stop path
   * and marked, so unpause resumes each thread in its own agent.
   */
  async stopThreads(
    input: z.infer<typeof import("../shared/contracts").stopThreads.input>,
  ): Promise<z.infer<typeof import("../shared/contracts").stopThreads.output>> {
    await this.started;
    if (!this.connected() || this.startError)
      throw new Error(this.startError || "Daemon is disconnected");
    return this.engine.stopActiveThreads(input);
  }

  /**
   * Legacy synchronous task control. Commands that perform a remote effect accept
   * durably first and keep the historical Task result only inside the bounded
   * compatibility window; a slower command returns its accepted operation so no
   * caller waits indefinitely. Local transactional controls stay synchronous.
   */
  /** Catalogue inputs may name tasks by reference; downstream code receives UUIDs. */
  resolveTaskReferences(input: unknown): unknown {
    if (Array.isArray(input))
      return input.map((value) => this.resolveTaskReferences(value));
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        if (
          ["taskId", "replacementTaskId", "until"].includes(key) &&
          typeof value === "string" &&
          value.includes("#")
        )
          return [key, this.store.resolveTaskId(value)];
        if (
          ["dependsOn", "waitsFor", "taskIds"].includes(key) &&
          Array.isArray(value)
        )
          return [
            key,
            value.map((id) =>
              typeof id === "string" ? this.store.resolveTaskId(id) : id,
            ),
          ];
        return [key, this.resolveTaskReferences(value)];
      }),
    );
  }

  async taskControl(
    request: TaskControlRequest,
  ): Promise<
    import("../shared/contracts").TaskControlTask | OperationAcceptance
  > {
    const input = this.engine.resolveTaskControl(request);
    const before = this.store.task(input.taskId);
    if (!controlHasExternalEffect(input)) {
      const task = await this.engine.performTaskControl(input);
      // Operator recovery must not wait behind a full retained-task audit.
      // Queue the affected task directly; the task lane still serializes it
      // with any audit quantum or concurrent control for the same identity.
      void this.engine.scheduleTaskQuantum(input.taskId);
      return task;
    }
    // Generated identity (Spec 012): the readable prefix keeps task, action and
    // version, and the normalized control digest fences the command. A rejected
    // control therefore never reserves the task/action/version namespace, so a
    // corrected instruction or disposition at the same version is accepted.
    const { key, payload } = taskControlOperation(input);
    const acceptance = await this.engine.startOperation({
      key,
      kind: "task_control",
      payload,
      taskId: payload.control.taskId,
      expectedVersion: payload.control.version,
    });
    if ("backpressured" in acceptance) return acceptance;
    const operation = await this.engine.awaitOperation(acceptance.operation.id);
    if (operation.state === "succeeded" && operation.result?.taskId)
      // A superseded external-effect action reports the same deprecation note as
      // its local sibling, even though the settled path re-reads the task row.
      return {
        ...this.store.task(operation.result.taskId),
        changes: taskControlChanges(
          before,
          this.store.task(operation.result.taskId),
        ),
      };
    if (operation.state === "failed")
      throw new Error(operation.diagnostic || "Task control failed");
    return { accepted: true, operation };
  }

  async bulkDisposition(input: BulkDispositionRequest) {
    await this.started;
    if (!this.connected() || this.startError)
      throw new Error(this.startError || "Daemon is disconnected");
    return this.engine.startBulkDisposition(input);
  }

  bulkDispositionDetail(input: { operationId: string }) {
    return this.engine.bulkDispositionDetail(input.operationId);
  }

  async retryBulkDisposition(input: { operationId: string }) {
    return this.engine.retryBulkDisposition(input.operationId);
  }

  async completionSubscription(input: {
    taskId: string;
    version: number;
    agentId: string;
    action: "subscribe" | "unsubscribe";
  }) {
    await this.started;
    if (!this.anyHostConnected())
      throw new Error(this.startError || "All hosts are disconnected");
    return this.engine.completionSubscription(input);
  }

  async reparent(input: ReparentInput) {
    await this.started;
    if (!this.anyHostConnected())
      throw new Error(this.startError || "All hosts are disconnected");
    const parsed = parseAgentId(input.toAgentId);
    const t3Hosts = this.hostRegistry
      .onlineIds()
      .filter((id) => hostKindOf(id) === "t3code");
    const candidates =
      parsed?.hostId && hostKindOf(parsed.hostId) === "t3code"
        ? [parsed.hostId]
        : !parsed
          ? t3Hosts
          : [];
    if (candidates.length) {
      const nativeAgentId = parsed?.nativeAgentId ?? input.toAgentId;
      const owners: string[] = [];
      for (const hostId of candidates) {
        try {
          const observation = await this.engine.withHost(hostId, () =>
            this.engine.host.observe(nativeAgentId),
          );
          if (
            observation?.id === nativeAgentId &&
            observation.status !== "gone"
          )
            owners.push(hostId);
        } catch {
          /* An unverified host cannot own the requested thread. */
        }
      }
      if (owners.length > 1)
        throw new Error(
          `T3Code thread ${nativeAgentId} is ambiguous; online T3 hosts: ${t3Hosts.join(", ") || "(none)"}`,
        );
      if (owners.length === 1)
        input = {
          ...input,
          toAgentId: formatAgentId(owners[0]!, nativeAgentId),
        };
    }
    return this.engine.reparent(input);
  }
  availabilityControl(
    input: z.infer<
      typeof import("../shared/contracts").availabilityControl.input
    >,
  ) {
    return this.settingsOperations.availabilityControl(input);
  }
  routingGrant(input: {
    action: "request" | "end" | "revoke";
    caller: string;
    reason?: string;
    profiles?: string[];
    until?: string | null;
    grantId?: string;
  }) {
    return this.settingsOperations.routingGrant(input);
  }
  async configureUsage(input: { level: UsageLevel; until?: string | null }) {
    return this.settingsOperations.configureUsage(input);
  }
  async configureDemandOffsets(input: DemandRoleOffsets) {
    return this.settingsOperations.configureDemandOffsets(input);
  }
  capacityAuthorityState() {
    return this.settingsOperations.capacityAuthorityState();
  }
  hostList() {
    this.markStoreAccess();
    return this.hostSettings.hostList();
  }
  removeHost(
    input: { hostId: string },
    _accepted?: unknown,
    context?: { via?: string | null },
  ) {
    return this.hostSettings.removeHost(input, _accepted, context);
  }
  async configureCapacity(
    input: z.infer<typeof capacitySchema>,
    _accepted?: unknown,
    context?: { via?: string | null },
  ) {
    return this.settingsOperations.configureCapacity(input, _accepted, context);
  }
  async configureProjectDispatchLimit(
    input: z.infer<typeof projectDispatchLimitSchema>,
  ) {
    return this.settingsOperations.configureProjectDispatchLimit(input);
  }
  upsertLane(input: import("../shared/contracts").LaneUpsertInput) {
    return this.planning.upsertLane(input);
  }
  setLaneStatus(input: {
    key: string;
    status: import("../shared/contracts").Lane["status"];
    note?: string;
  }) {
    return this.planning.setLaneStatus(input);
  }
  keepLane(input: { key: string; reason: string; author?: string }) {
    return this.planning.keepLane(input);
  }
  listLanes(
    input: {
      status?: import("../shared/contracts").Lane["status"];
      repository?: string;
    } = {},
  ) {
    return this.planning.listLanes(input);
  }
  async setRepository(input: RepositorySetInput) {
    return this.repositories.setRepository(input);
  }
  async getRepository(input: { repository: string }) {
    return this.repositories.getRepository(input);
  }
  listRepositories() {
    return this.repositories.listRepositories();
  }
  async rekeyRepository(
    input: RepositoryRekeyInput,
  ): Promise<RepositoryRekeyOutput> {
    return this.repositories.rekeyRepository(input);
  }
  previewRepositoryRekey(input: RepositoryRekeyPreviewInput) {
    return this.repositories.previewRepositoryRekey(input);
  }
  repositoryRekeyReceipt(input: RepositoryRekeyReceiptQuery) {
    return this.repositories.repositoryRekeyReceipt(input);
  }
  /**
   * The live-run presence projection, or null when this runtime's adapter has no
   * Paseo daemon to project into (a fixture adapter, or a unit-test adapter).
   */
  private createLiveRunPresence(): LiveRunPresence | null {
    const daemon = () =>
      (this.adapter as Adapter & { liveRunPresence?: RunPresenceDaemon })
        .liveRunPresence ?? null;
    if (!daemon()) return null;
    return new LiveRunPresence({
      dataDir: this.dataDir,
      stateDir: this.hostRunStateDir,
      runs: () => this.hostRuns.liveRuns(),
      settledRun: (id) => this.hostRuns.get(id),
      tasks: () => this.store.activeUiTasks(),
      qaRun: (id) => this.store.qaRun(id),
      daemon,
    });
  }

  /** Milestone QA (task 104): one Queue-owned full-QA run per repository on current `main`. */
  private retainedQaRunner: ProjectQaRunner | null = null;
  private projectQaRunner(): ProjectQaRunner {
    return (this.retainedQaRunner ??= new ProjectQaRunner(this.store, {
      dataDir: this.dataDir,
      hostRunStateDir: this.hostRunStateDir,
      ownerInstance: this.owner,
      notify: async (agentId, messageId, text) => {
        const identity = parseAgentId(agentId);
        const hostId =
          identity?.hostId ?? (await this.engine.identifyOriginHost(agentId));
        if (
          !hostId ||
          !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))
        )
          throw new Error("QA notification host is unavailable");
        await this.engine.withHost(hostId, () =>
          this.engine.host.sendMessage(identity?.nativeAgentId ?? agentId, {
            messageId,
            text,
          }),
        );
      },
    }));
  }
  async runProjectQa(input: {
    repository: string;
    baseBranch?: string;
    requestId?: string;
    expectedHead?: string;
    wait?: boolean;
  }) {
    return this.repositories.runProjectQa(input);
  }
  async cancelProjectQa(input: { id: string; reason: string }) {
    return this.repositories.cancelProjectQa(input);
  }
  async retryProjectQaTeardown(input: { id: string; reason: string }) {
    return this.repositories.retryProjectQaTeardown(input);
  }
  async dismissProjectQa(input: {
    id: string;
    reason: string;
    caller: string;
  }) {
    return this.repositories.dismissProjectQa(input);
  }
  async getProjectQa(input: { id: string } | { repository: string }) {
    return this.repositories.getProjectQa(input);
  }
  projectQaRequestStatus(
    input:
      | { requestId: string }
      | { repository: string; since: string; expectedHead: string },
  ) {
    return this.repositories.projectQaRequestStatus(input);
  }
  async listProjectQa() {
    return this.repositories.listProjectQa();
  }
  configureQaFence(input: ProjectQaFenceInput) {
    return this.repositories.configureQaFence(input);
  }
  qaFenceStatus() {
    return this.repositories.qaFenceStatus();
  }
  listHostRuns() {
    return this.repositories.listHostRuns();
  }
  releaseHostRunCapacity(input: { runId: string; reason: string }) {
    return this.repositories.releaseHostRunCapacity(input);
  }
  disposeHostRunAccounting(input: HostRunAccountingDisposeInput) {
    return this.repositories.disposeHostRunAccounting(input);
  }
  hostRunAccountingStatus(input: { runId: string }) {
    return this.repositories.hostRunAccountingStatus(input);
  }
  hostRunAccountingList() {
    return this.repositories.hostRunAccountingList();
  }
  hostRunBoard() {
    return this.repositories.hostRunBoard();
  }
  /** Re-attach to or heal running milestone QA runs after a service roll; best-effort and bounded. */
  private async recoverProjectQa() {
    if (this.closing) return;
    // A failure here leaves the run running for the next tick or board read; it
    // must never masquerade as a bootstrap or connection fault.
    try {
      await this.projectQaRunner().list();
    } catch {
      /* retried by the next sweep */
    }
  }
  async upsertProject(input: ProjectUpsertInput) {
    return this.repositories.upsertProject(input);
  }
  async getProject(
    input:
      | { key: string }
      | { repository: { origin: string | null; path: string } | string },
  ) {
    return this.repositories.getProject(input);
  }
  listProjects() {
    return this.repositories.listProjects();
  }
  parkProject(input: { key: string; version: number }) {
    return this.repositories.parkProject(input);
  }
  unparkProject(input: { key: string; version: number }) {
    return this.repositories.unparkProject(input);
  }
  async setProjectPlanner(input: {
    key: string;
    agentId: string | null;
    setBy?: string;
    note?: string;
  }) {
    return this.repositories.setProjectPlanner(input);
  }
  projectAgents(input: { project: string }) {
    return this.repositories.projectAgents(input);
  }
  registerProjectAgent(
    input: import("../shared/contracts").AgentRegisterInput,
  ) {
    return this.repositories.registerProjectAgent(input);
  }
  unregisterProjectAgent(
    input: import("../shared/contracts").AgentUnregisterInput,
  ) {
    return this.repositories.unregisterProjectAgent(input);
  }
  projectOwnerCandidates() {
    return this.repositories.projectOwnerCandidates();
  }
  projectSettings() {
    return this.repositories.projectSettings();
  }
  resetProjectCancellation(input: {
    key: string;
    operationId: string;
    tasks: Array<{ taskId: string; version: number }>;
  }) {
    return this.repositories.resetProjectCancellation(input);
  }
  projectManagementPreview(input: { key: string; target?: string }) {
    return this.repositories.projectManagementPreview(input);
  }
  manageRemoveProject(input: import("../shared/contracts").ProjectManageInput) {
    return this.repositories.manageRemoveProject(input);
  }
  removeProject(input: { key: string; version: number; reason: string }) {
    return this.repositories.removeProject(input);
  }
  removalBlockers(input: { key: string; repository?: string }) {
    return this.repositories.removalBlockers(input);
  }
  removeProjectRepository(
    input: import("../shared/contracts").ProjectRemoveRepositoryInput,
  ) {
    return this.repositories.removeProjectRepository(input);
  }
  mergeProject(input: import("../shared/contracts").ProjectMergeInput) {
    return this.repositories.mergeProject(input);
  }
  mergeCheck(input: import("../shared/contracts").ProjectMergeCheckInput) {
    return this.repositories.mergeCheck(input);
  }

  async refreshCatalog() {
    await this.started;
    const adapter = this.paseo;
    if (!this.connected() || !hostConnected(adapter)) {
      await this.ensureBootstrap();
      if (!this.connected())
        throw new Error(
          this.startError || "Host is offline or its identity is unknown",
        );
    }
    await this.refresh();
    void this.wakeAndSettlePostBootstrapTimeout();
    return { ok: true as const };
  }
  async submitHandoff(
    input: import("../core/planning/handoff").HandoffInput & {
      identitySource?: import("../shared/host-kind").IdentitySource;
    },
  ) {
    const { identitySource, ...handoff } = input;
    return this.planning.submitHandoff({
      ...handoff,
      ...(identitySource ? { originIdentity: identitySource } : {}),
    });
  }

  /**
   * Legacy synchronous removal. The Effigy runtime-scope capture and workspace
   * retirement run inside a durable `task_remove` operation: the historical
   * Task result is preserved only inside the bounded compatibility window, and
   * a slower removal returns its accepted operation for `operation-status`
   * observation. The key is deterministic on task and version, so repeating the
   * same removal replays the same operation.
   */
  async removeTask(input: {
    taskId: string;
    version: number;
  }): Promise<import("../shared/contracts").Task | OperationAcceptance> {
    await this.started;
    const payload = {
      type: "task_remove" as const,
      taskId: input.taskId,
      version: input.version,
    };
    const key = `task-remove:${input.taskId}:${input.version}:${operationInputHash(payload)}`;
    if (key.length > TASK_CONTROL_KEY_LIMIT)
      throw new Error(
        `Task-remove operation key exceeds the ${TASK_CONTROL_KEY_LIMIT}-character caller-key bound; Nucleus never truncates task identity`,
      );
    const acceptance = await this.engine.startOperation({
      key,
      kind: "task_remove",
      payload,
      taskId: input.taskId,
      expectedVersion: input.version,
    });
    if ("backpressured" in acceptance) return acceptance;
    const operation = await this.engine.awaitOperation(acceptance.operation.id);
    if (operation.state === "succeeded" && operation.result?.taskId)
      return this.store.task(operation.result.taskId);
    if (operation.state === "failed")
      throw new Error(operation.diagnostic || "Task removal failed");
    return { accepted: true, operation };
  }

  /**
   * Spec 058 slice 4: any thread registers itself as a responsible task.
   * The caller rides the CLI from its Nucleus ticket or host identity, never a typed name, and the
   * service binds the task to that thread's own live worktree. The Paseo
   * bridge path carries no reliable caller identity and is refused.
   *
   * Resolution order (every host kind): prove the thread on a live host, then the
   * current run ticket for that identity, then a participant ticket, then the
   * host-verified identity. A slow host answers "The host is slow; retry".
   */
  async resolveHostCaller(input: {
    hostKind: HostKind;
    nativeAgentId: string;
    hostScope?: string;
  }) {
    const { resolveHostCallerIdentity } = await import(
      "../core/dispatch/caller-resolution"
    );
    const adapter = this.adapter as { helperPath?: string } | undefined;
    return resolveHostCallerIdentity(
      {
        onlineIds: () => this.hostRegistry.onlineIds(),
        observe: (hostId, nativeAgentId) =>
          this.engine.withHost(hostId, () =>
            this.engine.host.observe(nativeAgentId),
          ),
        unreleasedRuns: this.store
          ? (caller, hostId) =>
              this.store.unreleasedRunsForAgent(caller, hostId)
          : undefined,
        helperPath: adapter?.helperPath,
        participantTicket: (caller) => this.plannerTickets.forCaller(caller),
      },
      input,
    );
  }

  /** Catalogue tell for a host-verified thread that has no run or participant ticket. */
  async tellFromHost(input: {
    hostKind: HostKind;
    nativeAgentId: string;
    hostScope?: string;
    eventId: string;
    to: import("../core/questions/agent-messages").AgentMessageRequest["to"];
    role?: import("../core/questions/agent-messages").AgentMessageRequest["role"];
    text: string;
  }) {
    await this.started;
    const identity = await this.resolveHostCaller(input);
    return this.engine.resolution.hostAgentMessage(
      { caller: identity.caller, hostId: identity.hostId },
      {
        eventId: input.eventId,
        to: input.to,
        role: input.role,
        text: input.text,
      },
    );
  }

  async registerTask(
    input: import("../shared/contracts").TaskRegistrationInput,
    _accepted: unknown,
    context?: { via?: string | null },
  ) {
    await this.started;
    if (!this.anyHostConnected())
      throw new Error(this.startError || "All hosts are disconnected");
    const caller = parseAgentId(input.caller);
    if (caller && input.hostId && caller.hostId !== input.hostId)
      throw new Error(
        "Calling thread belongs to a different registration host",
      );
    const hostId = this.engine.selectIngressHost(
      input.hostId ?? caller?.hostId,
    );
    if (
      !hostId ||
      !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))
    )
      throw new Error("Selected registration host is unavailable");
    const { registerTask } = await import("../core/host/registration");
    const result = await this.engine.withHost(hostId, () =>
      registerTask(
        this.store,
        this.engine.adapter as Adapter & RegistrationAdapter,
        this.engine.profiles,
        input,
        { via: context?.via ?? null },
      ),
    );
    void this.wakeAndSettlePostBootstrapTimeout();
    return result;
  }
}

/**
 * Build the module-global owner exactly as the legacy runtime did. Kept as a
 * separate factory so the service entry can reuse the same construction.
 */
export function createQueueRuntime(
  options: RuntimeOwnerOptions = {},
): QueueRuntime {
  return new QueueRuntime(options);
}
