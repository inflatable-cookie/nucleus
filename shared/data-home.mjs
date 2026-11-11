// The one data-home resolver.
//
// The plugin bundle refuses a Node import from any shared/ module, so this reads the
// filesystem, home directory and path helpers without one; every function here works
// from `process.getBuiltinModule`, and a runtime without those builtins (the client
// bundle in a browser) does no discovery and keeps the default.
//
// The data home is `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set. Tom, 2026-11-09:
// retire the move machinery (the move completed 08:05 UTC that day). This resolver
// reads no journal, knows no legacy leaf, and ignores `PASEO_HOME`. A leftover
// `~/.nucleus-stage-journal.json` and a sealed `~/.paseo/northstar-queue` are ignored.
// Resolution for `process.env` is computed once per process.
//
// Absence and failure are different answers. A missing or empty `~/.nucleus` is
// the creation default; a file or a non-empty directory without Nucleus store
// markers is refused (another product's state); any other filesystem error is a
// refusal, so an unreadable folder can never be mistaken for an empty one and
// quietly adopted.
//
// `test/data-home.test.ts` proves the resolution rules.
//
// The file uses `getBuiltinModule('node:path')` rather than a POSIX hand-roll so this
// preserves `path.join` behavior on `.`, `..`, repeated slashes and a trailing
// slash. The file uses the same builtin hook for `os.homedir`.

const builtin = name => process.getBuiltinModule?.(name);

/** The data home, a directory directly under the account home: `~/.nucleus`. */
export const CURRENT_DATA_HOME_LEAF = ".nucleus";
/** Explicit selection of the whole data home. */
export const DATA_HOME_ENV = "NUCLEUS_DATA_HOME";
/**
 * A directory is a Nucleus store only when it holds one of these; an unrelated
 * directory that happens to sit at a known path is never adopted. `queue.sqlite` is
 * the store, `settings.json` and `queue-service.json` are the durable settings and
 * service-identity files that identify an installed data home whose store file has
 * been moved away by hand.
 */
export const STORE_MARKERS = ["queue.sqlite", "settings.json", "queue-service.json"];

/**
 * Every path Nucleus may find under a data home, the module that owns it, and
 * whether it is durable, ephemeral or derived. `durable` holds records and identities
 * that must never be dropped, rewritten or recreated; `ephemeral` is a live socket,
 * claim or process marker that is never copied as proof of a running service and is
 * recreated only after exclusive ownership; `derived` can be rebuilt from the store.
 * Recorded task worktree, scratch and snapshot paths may live outside the data home
 * and keep their exact existing values.
 */
export const DATA_HOME_ENTRIES = Object.freeze([
  { path: "queue.sqlite", kind: "durable", owner: "server/runtime-owner.ts" },
  { path: "queue.sqlite-wal", kind: "durable", owner: "server/runtime-owner.ts" },
  { path: "queue.sqlite-shm", kind: "durable", owner: "server/runtime-owner.ts" },
  { path: "settings.json", kind: "durable", owner: "server/runtime-owner.ts" },
  { path: "profiles/", kind: "durable", owner: "server/runtime-owner.ts" },
  { path: "tickets/", kind: "durable", owner: "server/callback.ts" },
  { path: "backups/", kind: "durable", owner: "core/store/backup-worker.mjs (fixtures); core/store/data-home-retention.ts (live stale copies)" },
  { path: "shadow-stream/", kind: "durable", owner: "retired contract 009 producer" },
  { path: "shadow-seeds/", kind: "durable", owner: "retired contract 009 producer" },
  { path: "isolation/", kind: "durable", owner: "core/hooks/hooks.ts; core/hooks/hook-cleanup.ts (settled checkout retention)" },
  { path: "queue-hooks/", kind: "durable", owner: "core/hooks/hooks.ts" },
  { path: "project-qa/", kind: "durable", owner: "core/qa/project-qa-supervisor.ts (logs/results); core/qa/project-qa.ts (settled checkout retention)" },
  { path: ".external-backups/", kind: "durable", owner: "core/store/data-home-retention.ts (migration copy; live data home only)" },
  { path: "project-validation/", kind: "durable", owner: "core/qa/project-validation-supervisor.ts" },
  { path: "callback.sock", kind: "ephemeral", owner: "server/callback.ts" },
  { path: "worker-report.mjs", kind: "derived", owner: "server/runtime-owner.ts" },
  { path: "queue-service.sock", kind: "ephemeral", owner: "server/service/identity.ts" },
  { path: "queue-service.json", kind: "durable", owner: "server/service/identity.ts" },
  { path: "queue-service-roll.json", kind: "durable", owner: "server/service/identity.ts" },
  { path: "queue-service-startup-failure.json", kind: "durable", owner: "server/service/identity.ts" },
  { path: "queue-service-executor-fault.json", kind: "durable", owner: "server/service/identity.ts" },
  { path: "queue-service.claim.json", kind: "ephemeral", owner: "hosts/paseo/plugin/bridge.ts" },
  { path: "queue-service-<pid>.maintenance", kind: "ephemeral", owner: "server/service/standby.ts" },
  { path: "queue-standby-<pid>.ready", kind: "ephemeral", owner: "server/service/standby.ts" },
  { path: "oversize-response.json", kind: "derived", owner: "server/service/server.ts" },
  { path: "host-run/", kind: "ephemeral", owner: "service/callbacks/host-run-endpoint.ts" },
  { path: "run/", kind: "ephemeral", owner: "service/callbacks/host-run-endpoint.ts" },
]);

/** The refusal names the path it compared, so the caller never has to go looking. */
function refusal(code, message) {
  const error = new Error(message);
  error.name = "DataHomeError";
  error.code = `data-home:${code}`;
  return error;
}

/** True for a refusal this module raised, including one that crossed a JSON boundary. */
export const isDataHomeError = error =>
  Boolean(error) && (error.name === "DataHomeError" || String(error.code ?? "").startsWith("data-home:"));

const pathModule = () => builtin("node:path");

/** `path.join` where Node is available; the browser-side fallback keeps the same shape. */
export function joinPath(...parts) {
  const path = pathModule();
  if (path) return path.join(...parts);
  return parts.reduce((left, right) => `${String(left).replace(/\/+$/, "")}/${String(right).replace(/^\/+/, "")}`);
}

/** The account's home: `HOME` when it has content, else the OS answer. */
export function homeDirectory(env = process.env) {
  return env.HOME?.trim() || builtin("node:os")?.homedir?.() || "";
}

/** The one explicit selection that names a whole data home, normalised; null when unset. */
function selectedDataHome(env) {
  const value = env[DATA_HOME_ENV];
  if (!value) return null;
  if (value.startsWith("~")) throw refusal("tilde", `${DATA_HOME_ENV}=${value} starts with "~", which is never expanded here; name the absolute path instead`);
  const path = pathModule();
  return path ? path.normalize(value) : value.replace(/\/+$/, "");
}

/**
 * True when this directory holds a Nucleus store. Only the marker files are tested, so
 * an unrelated directory at `~/.nucleus` (another product's own state) is never adopted.
 * A missing marker is absence; any other filesystem error is a refusal, so an unreadable
 * folder is never reported as an empty one.
 */
export function holdsStore(root, stat = builtin("node:fs")?.statSync) {
  if (typeof stat !== "function") return false;
  for (const marker of STORE_MARKERS) {
    const path = joinPath(root, marker);
    try {
      stat(path);
      return true;
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw refusal("unreadable", `cannot tell whether ${root} holds a Nucleus store: ${path} could not be read (${code ?? error?.message ?? "unknown error"})`);
    }
  }
  return false;
}

/**
 * `~/.nucleus` is the default. Missing and an empty directory are the creation
 * default (the service mkdir's the folder before it writes store markers). A
 * file or a non-empty directory without store markers is another product's
 * state and is never adopted.
 */
function inspectDefault(root) {
  const fs = builtin("node:fs");
  if (!fs?.statSync) return "default";
  let st;
  try {
    st = fs.statSync(root);
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") return "default";
    throw refusal("unreadable", `cannot tell whether ${root} holds a Nucleus store (${code ?? error?.message ?? "unknown error"})`);
  }
  if (typeof st.isDirectory === "function" ? !st.isDirectory() : false) {
    throw refusal("occupied", `${root} exists and is not a Nucleus store; Nucleus will not adopt another product's directory. Set ${DATA_HOME_ENV} to a dedicated path for an isolated data home`);
  }
  if (holdsStore(root)) return "store";
  try {
    if ((fs.readdirSync?.(root) ?? []).length === 0) return "default";
  } catch (error) {
    const code = error?.code;
    throw refusal("unreadable", `cannot tell whether ${root} holds a Nucleus store (${code ?? error?.message ?? "unknown error"})`);
  }
  throw refusal("occupied", `${root} exists and is not a Nucleus store; Nucleus will not adopt another product's directory. Set ${DATA_HOME_ENV} to a dedicated path for an isolated data home`);
}

let processResolution;

function computeDataHome(env) {
  const override = selectedDataHome(env);
  const root = override ?? joinPath(homeDirectory(env), CURRENT_DATA_HOME_LEAF);
  if (override) return { root, source: "override" };
  return { root, source: inspectDefault(root) };
}

/**
 * Resolve the one data home this process uses.
 *
 * Returns `{ root, source }`: `root` is the directory, `source` is `"override"`,
 * `"store"` or `"default"`. Throws a `DataHomeError` rather than adopting an
 * unrelated directory at `~/.nucleus`. For `process.env` the answer is computed
 * once and reused for the rest of the process.
 */
export function resolveDataHome(env = process.env) {
  if (env === process.env && processResolution) {
    if (processResolution.error) throw processResolution.error;
    return processResolution.value;
  }
  try {
    const value = computeDataHome(env);
    if (env === process.env) processResolution = { value };
    return value;
  } catch (error) {
    if (env === process.env) processResolution = { error };
    throw error;
  }
}

/**
 * The data home this process uses. Ambiguous configurations throw, so every caller —
 * service, bridge, CLI, helper or worker — fails closed instead of opening a store the
 * operator did not select.
 */
export const dataHome = (env = process.env) => resolveDataHome(env).root;
