/**
 * A paired-API stand-in for the engine's planning items, speaking the stored shapes
 * the service serializes (`nucleus-store` `Item` / `ItemWithTimes` / `History`, routes
 * in `nucleus-service/src/web/planning.rs`). It keeps the store's rules that the
 * lead and papercut view depends on: one history sequence that is every item's
 * version, park from open or parked, drop from anything but promoted, reopen only
 * from parked or dropped at the current version, versioned board edits, and
 * promotion only from open or parked into a bound repository.
 */

export type StoredItem = {
  id: string;
  kind: "lead" | "papercut";
  author: string;
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

type History = { sequence: number; actor: string; atMs: number; action: string; snapshot: unknown };

type Repository = { origin: string; path: string; base: string; requiredChecks: string[]; hungToolMinutes: number; hostProject?: string };

export const planningProjects: Record<string, { name: string; archived: boolean; repositories: Repository[] }> = {
  nucleus: {
    name: "Nucleus",
    archived: false,
    repositories: [
      { origin: "example/nucleus", path: "/work/nucleus", base: "main", requiredChecks: [], hungToolMinutes: 30, hostProject: "t3-nucleus" },
    ],
  },
  acowtancy: {
    name: "Acowtancy",
    archived: false,
    repositories: [
      { origin: "example/acowtancy-v2", path: "/work/acowtancy-v2", base: "main", requiredChecks: [], hungToolMinutes: 30, hostProject: "t3-acowtancy" },
      { origin: "example/dairy", path: "/work/dairy", base: "main", requiredChecks: [], hungToolMinutes: 30 },
    ],
  },
};

const snapshot = (value: unknown) => ({ value, revision: "1", configured: true });

const settings = () => ({
  profiles: { ...snapshot({ profiles: [], pausedGroups: [] }), effectiveGroups: {} },
  dispatch: snapshot({
    usage: "normal",
    usageUntilMs: null,
    globalSlots: 4,
    projectDefaultSlots: 2,
    projectSlotOverrides: {},
    providerLimitCooldownSeconds: 300,
    mode: "running",
  }),
  projects: { settings: snapshot({ projects: planningProjects }), resolvedPlanners: {} },
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
  const items = new Map<string, { project: string; item: StoredItem; createdAtMs: number }>();
  const history: Array<History & { project: string; id: string }> = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let sequence = 0;
  let tasks = 0;

  const record = (project: string, id: string, actor: string, atMs: number, action: string, snapshot: unknown) =>
    history.push({ project, id, sequence: ++sequence, actor, atMs, action, snapshot });

  /** Files an item at `atMs` and replays `steps` as later history, as the store would have recorded them. */
  function seed(
    project: string,
    item: StoredItem,
    filed: { actor: string; atMs: number },
    steps: Array<{ actor: string; atMs: number; action: string; item: StoredItem; note?: string }> = [],
  ) {
    record(project, item.id, filed.actor, filed.atMs, "add", { ...item, state: "open" });
    for (const step of steps) record(project, item.id, step.actor, step.atMs, step.action, step.note ? { ...step.item, note: step.note } : step.item);
    items.set(key(project, item.id), { project, item, createdAtMs: filed.atMs });
  }

  const key = (project: string, id: string) => `${project}/${id}`;
  const withTimes = (project: string, id: string) => {
    const entry = items.get(key(project, id))!;
    const own = history.filter((row) => row.project === project && row.id === id);
    return { ...entry.item, version: own.at(-1)!.sequence, createdAtMs: entry.createdAtMs, updatedAtMs: own.at(-1)!.atMs };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conflict = () => json({ error: "planning record conflict" }, 409);

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("/api/engine", "");
    const method = init?.method ?? "GET";
    if (path === "/session") return json({ id: "operator-session", canEditSettings: true, planningProjects: null });
    if (path === "/settings") return json(settings());
    if (path === "/tasks") return json([]);
    const match = /^\/planning\/([^/]+)\/(items|history\/item)(?:\/([^/]+))?(?:\/(park|drop|reopen|promote))?$/.exec(path);
    if (!match) return json({ error: `no route ${path}` }, 404);
    const [, project, collection, rawId, action] = match as unknown as [string, string, string, string | undefined, string | undefined];
    const id = rawId && decodeURIComponent(rawId);
    if (collection === "history/item")
      return json(
        history
          .filter((row) => row.project === project && row.id === id)
          .map(({ sequence, actor, atMs, action, snapshot }) => ({ sequence, actor, atMs, action, snapshot })),
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
      case "promote": {
        if (current.state !== "open" && current.state !== "parked") return conflict();
        const repos = planningProjects[project]!.repositories;
        const target = body.repository ? repos.find((repo) => repo.origin === body.repository) : repos[0];
        if (!target?.hostProject) return json({ error: "repository is not bound to T3" }, 400);
        const taskId = `t-promoted-${++tasks}`;
        save({ ...base(current), taskLinks: [taskId], state: "promoted", taskId }, "promote");
        return json({ identity: { id: taskId }, reference: `${target.origin.split("/")[1]}#${1200 + tasks}` }, 201);
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
  function editElsewhere(project: string, id: string, title: string) {
    const entry = items.get(key(project, id))!;
    entry.item = { ...entry.item, title };
    record(project, id, "planner", now(), "edit", entry.item);
  }

  return { fetcher, seed, writes, editElsewhere, item: (project: string, id: string) => withTimes(project, id) };
}

function base(item: StoredItem) {
  const { id, kind, author, title, body, lanes, repositories, taskLinks } = item;
  return { id, kind, author, title, body, lanes, ...(repositories ? { repositories } : {}), ...(taskLinks ? { taskLinks } : {}) };
}
