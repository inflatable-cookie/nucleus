/**
 * A paired-API stand-in for the engine's planning items, speaking the stored shapes
 * the service serializes (`nucleus-store` `Item` / `ItemWithTimes` / `History`, routes
 * in `nucleus-service/src/web/planning.rs`). It keeps the store's rules that the
 * lead and papercut view depends on: one history sequence that is every item's
 * version, park from open or parked, drop from anything but promoted, reopen only
 * from parked or dropped at the current version, versioned board edits, and
 * promotion only from open or parked into a bound repository. Promotion follows
 * the service's admission rules (`nucleus-service/src/planning.rs`
 * `promote_planning_item`, `enrollment.rs`; store `promote_item_with_facts`): a
 * promotion naming a version is refused once the item moved past it; a lead's
 * different level is written into its brief and saved only together with the
 * admitted task; the brief must declare a complexity; and without an explicit
 * repository only a project with exactly one bound repository has a destination.
 * Any refusal leaves the item unchanged. `refuseNextAdmission` makes admission
 * fail after the checks, as a store failure inside the transaction would.
 */

export type StoredItem = {
  id: string;
  kind: "lead" | "papercut";
  author: string;
  authorProjectId?: string;
  title: string;
  body: string;
  lanes: string[];
  repositories?: string[];
  taskLinks?: string[];
} & (
  | { state: "open" }
  | { state: "parked"; reason: string; revisitAt: string | null }
  | { state: "promoted"; taskId: string }
  | { state: "dropped"; disposition: "completed" | "deprecated"; reason: string | null }
);

type History = { sequence: number; actor: string; actorLabel: string; atMs: number; action: string; snapshot: unknown };

type Repository = { origin: string; path: string; base: string; hostProject?: string };
type PlanningProject = {
  name: string;
  archived: boolean;
  repositories: Repository[];
  plannerClaim?: { thread: string; occurrence: string; replaced?: string };
  claimedPlannerThreads?: string[];
};

export const planningProjects: Record<string, { name: string; archived: boolean; repositories: Repository[] }> = {
  nucleus: {
    name: "Nucleus",
    archived: false,
    repositories: [
      { origin: "example/nucleus", path: "/work/nucleus", base: "main", hostProject: "t3-nucleus" },
    ],
  },
  acowtancy: {
    name: "Acowtancy",
    archived: false,
    repositories: [
      { origin: "example/acowtancy-v2", path: "/work/acowtancy-v2", base: "main", hostProject: "t3-acowtancy" },
      { origin: "example/dairy", path: "/work/dairy", base: "main" },
    ],
  },
  orchard: {
    name: "Orchard",
    archived: false,
    repositories: [
      { origin: "example/orchard-api", path: "/work/orchard-api", base: "main", hostProject: "t3-orchard-api" },
      { origin: "example/orchard-web", path: "/work/orchard-web", base: "main", hostProject: "t3-orchard-web" },
    ],
  },
};

/**
 * The brief's declared `queue.complexity`, block or flow YAML, standing in for the
 * service's brief policy (`BriefPolicy::submitted`), which the real engine runs.
 */
function declaredComplexity(body: string): string | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
  const flow = /^queue:[ \t]*\{([^}]*)\}/m.exec(front)?.[1];
  if (flow !== undefined) return /(?:^|,)\s*complexity:\s*([a-z_]+)/.exec(flow)?.[1] ?? null;
  return /^queue:\n(?:[ \t]+.*\n)*?[ \t]+complexity:[ \t]*([a-z_]+)/m.exec(front + "\n")?.[1] ?? null;
}

const snapshot = (value: unknown) => ({ value, revision: "1", configured: true });

const settings = (projects: Record<string, PlanningProject> = planningProjects) => ({
  profiles: { ...snapshot({ profiles: [], pausedGroups: [] }), effectiveGroups: {} },
  dispatch: snapshot({
    usage: "normal",
    usageUntilMs: null,
    heavySlots: 4,
    normalSlots: 0,
    lightSlots: 0,
    projectDefaultSlots: 2,
    projectSlotOverrides: {},
    mode: "running",
  }),
  projects: { settings: snapshot({ projects }), resolvedPlanners: {} },
  hosts: {
    settings: snapshot({ t3: { endpoint: "http://127.0.0.1:3773/", credentialRef: "T3" } }),
    active: { endpoint: "http://127.0.0.1:3773/", status: "reachable" },
  },
  storage: {
    settings: snapshot({ enabled: true, workRoot: null, scratchRoot: null, logRoot: null, retention: { keepNewest: 5, maxAgeDays: null } }),
    active: { databaseRoot: "/e/db", workRoot: "/e/work", backupRoot: "/e/backups", scratchRoot: "/e/scratch", logRoot: "/e/logs" },
    configBackups: { complete: true, issues: 0, verified: [] },
    backups: { complete: true, issues: 0, verified: [] },
  },
});

export function planningEngine(now: () => number = Date.now) {
  const projectSettings: Record<string, PlanningProject> = Object.fromEntries(
    Object.entries(planningProjects).map(([id, project]) => [id, { ...project }]),
  );
  const items = new Map<string, { project: string; item: StoredItem; createdAtMs: number }>();
  const history: Array<History & { project: string; id: string }> = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const threadTitles = new Map<string, string>();
  let sequence = 0;
  const recipients = new Map<string, string>();

  const actorLabel = (project: string, actor: string) => {
    if (/^(operator|nucleus:operator|fixture-operator)$/i.test(actor) || /^operator via /i.test(actor)) return "Operator";
    const isClaimedPlanner = (settings: PlanningProject | undefined) =>
      settings &&
      (settings.claimedPlannerThreads?.includes(actor) ||
        settings.plannerClaim?.thread === actor ||
        settings.plannerClaim?.replaced === actor);
    const settings = projectSettings[project];
    const claimedProject = isClaimedPlanner(settings)
      ? settings
      : Object.values(projectSettings).find(isClaimedPlanner);
    if (claimedProject) return `${claimedProject.name} planner`;
    return threadTitles.get(actor) || "Agent thread";
  };
  const recipientLabel = (project: string, recipient: string) =>
    recipient === "new planner thread" ? recipient : actorLabel(project, recipient);
  const record = (project: string, id: string, actor: string, atMs: number, action: string, snapshot: unknown) =>
    history.push({ project, id, sequence: ++sequence, actor, actorLabel: actorLabel(project, actor), atMs, action, snapshot });

  /** Files an item at `atMs` and replays `steps` as later history, as the store would have recorded them. */
  function seed(
    project: string,
    item: StoredItem,
    filed: { actor: string; atMs: number },
    steps: Array<{
      actor: string; atMs: number; action: string; item: StoredItem; note?: string; recipient?: string;
      /** An assessment outcome's cause, and the history sequence of its send. */
      cause?: string; send?: number;
    }> = [],
  ) {
    record(project, item.id, filed.actor, filed.atMs, "add", { ...item, state: "open" });
    for (const step of steps) {
      const snapshot = {
        ...step.item,
        ...(step.note ? { note: step.note } : {}),
        ...(step.recipient ? { recipient: step.recipient } : {}),
        ...(step.cause ? { cause: step.cause } : {}),
        ...(step.send ? { send: step.send } : {}),
      };
      record(project, item.id, step.actor, step.atMs, step.action, snapshot);
    }
    items.set(key(project, item.id), { project, item, createdAtMs: filed.atMs });
  }

  const key = (project: string, id: string) => `${project}/${id}`;
  const withTimes = (project: string, id: string) => {
    const entry = items.get(key(project, id))!;
    const own = history.filter((row) => row.project === project && row.id === id);
    const complexity = entry.item.kind === "lead" ? declaredComplexity(entry.item.body) : null;
    return {
      ...entry.item,
      authorLabel: entry.item.authorProjectId
        ? `${projectSettings[entry.item.authorProjectId]?.name ?? "Agent thread"} planner`
        : actorLabel(project, entry.item.author),
      version: own.at(-1)!.sequence,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: own.at(-1)!.atMs,
      ...(complexity ? { complexity } : {}),
    };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conflict = () => json({ error: "planning record conflict" }, 409);

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("/api/engine", "");
    const method = init?.method ?? "GET";
    if (path === "/session") return json({ id: "operator-session", canEditSettings: true, planningProjects: null });
    if (path === "/settings") return json(settings(projectSettings));
    if (path === "/tasks") return json([]);
    const match = /^\/planning\/([^/]+)\/(items|history\/item)(?:\/([^/]+))?(?:\/(park|drop|reopen|assess))?$/.exec(path);
    if (!match) return json({ error: `no route ${path}` }, 404);
    const [, project, collection, rawId, action] = match as unknown as [string, string, string, string | undefined, string | undefined];
    const id = rawId && decodeURIComponent(rawId);
    if (collection === "history/item")
      return json(
        history
          .filter((row) => row.project === project && row.id === id)
          .map(({ sequence, actor, actorLabel, atMs, action, snapshot }) => {
            const recipient = typeof snapshot === "object" && snapshot !== null && "recipient" in snapshot && typeof snapshot.recipient === "string"
              ? snapshot.recipient
              : undefined;
            return {
              sequence,
              actor,
              actorLabel,
              atMs,
              action,
              snapshot,
              ...(action === "assess" && recipient ? { recipientLabel: recipientLabel(project, recipient) } : {}),
            };
          }),
      );
    if (!id) return json([...items.values()].filter((entry) => entry.project === project).map((entry) => withTimes(project, entry.item.id)));
    const entry = items.get(key(project, id));
    if (!entry) return json({ error: "planning record missing" }, 404);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ method, path, body });
    const at = now();
    const current = entry.item;
    const save = (next: StoredItem, verb: string, note?: string) => {
      entry.item = next;
      record(project, id, "operator", at, verb, note ? { ...next, note } : next);
    };
    switch (action) {
      case "park":
        if (!body.reason?.trim() || (current.state !== "open" && current.state !== "parked")) return conflict();
        save({ ...base(current), state: "parked", reason: body.reason, revisitAt: body.revisitAt ?? null }, "park");
        return json(entry.item);
      case "drop":
        if (current.state === "promoted") return conflict();
        save({ ...base(current), state: "dropped", disposition: body.disposition ?? "deprecated", reason: body.reason ?? null }, "drop");
        return json(entry.item);
      case "reopen": {
        const version = withTimes(project, id).version;
        if ((body.version !== undefined && body.version !== version) || (current.state !== "parked" && current.state !== "dropped")) return conflict();
        save({ ...base(current), state: "open" }, "reopen", body.note);
        return json(withTimes(project, id));
      }
      case "assess": {
        if (current.state !== "open" && current.state !== "parked") return conflict();
        if (!(body.version > 0) || body.version !== withTimes(project, id).version) return conflict();
        const recipient = recipients.get(project) ?? "new planner thread";
        record(project, id, "operator", at, "assess", { ...current, recipient });
        return json(withTimes(project, id));
      }
      default: {
        if (method !== "PUT") return json({ error: "method" }, 405);
        if (!(body.version > 0) || body.version !== withTimes(project, id).version) return conflict();
        entry.item = { ...current, title: body.title, body: body.body, lanes: body.lanes };
        record(project, id, "operator", at, "edit", entry.item);
        return json(withTimes(project, id));
      }
    }
  }) as typeof fetch;

  /** A concurrent writer: another edit lands between the view's read and its save. */
  function editElsewhere(project: string, id: string, change: { title?: string; body?: string }) {
    const entry = items.get(key(project, id))!;
    entry.item = { ...entry.item, ...change };
    record(project, id, "planner", now(), "edit", entry.item);
  }

  return {
    fetcher,
    seed,
    setThreadTitle: (id: string, title: string) => threadTitles.set(id, title),
    setProjectSettings: (id: string, change: Partial<PlanningProject>) => {
      projectSettings[id] = {
        ...(projectSettings[id] ?? { name: id, archived: false, repositories: [] }),
        ...change,
      };
    },
    writes,
    editElsewhere,
    setRecipient: (project: string, recipient: string) => {
      recipients.set(project, recipient);
    },
    item: (project: string, id: string) => withTimes(project, id),
  };
}

function base(item: StoredItem) {
  const { id, kind, author, authorProjectId, title, body, lanes, repositories, taskLinks } = item;
  return { id, kind, author, ...(authorProjectId ? { authorProjectId } : {}), title, body, lanes, ...(repositories ? { repositories } : {}), ...(taskLinks ? { taskLinks } : {}) };
}
