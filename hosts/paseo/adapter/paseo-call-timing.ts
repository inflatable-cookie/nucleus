import { paseoCall, hasPaseoCallTiming } from "../../../shared/host-call-timing";
export { paseoCall, withPaseoCallTiming } from "../../../shared/host-call-timing";
export type { PaseoCallRecorder } from "../../../shared/host-call-timing";

/**
 * DaemonClient methods that each send exactly one daemon request (installed
 * @getpaseo/client daemon-client.js: one sendRequest or correlated request
 * each). With a `subscribe` option the two list methods open a subscription
 * instead, so that form passes through untimed.
 */
const SINGLE_REQUEST: ReadonlySet<string> = new Set(["fetchWorkspaces", "fetchAgents", "fetchAgent", "fetchAgentTimeline", "archiveWorkspace"]);

/**
 * The daemon client the SDK API is built on, with each single-request method
 * timed by `paseoCall`. SDK helpers that page (workspace refresh walks
 * `fetchWorkspaces`) therefore yield one sample per request. Every other
 * member is the client's own, bound to the client, and nothing is timed
 * outside an inner-timed run.
 */
export function timedDaemonRequests<T extends object>(client: T): T {
  const members = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const known = members.get(prop) as { fn: unknown; member: unknown } | undefined;
      if (known?.fn === value) return known.member;
      const fn = value as (...args: unknown[]) => unknown;
      const member = typeof prop === "string" && SINGLE_REQUEST.has(prop)
        ? (...args: unknown[]) => {
          const subscribing = (args[0] as { subscribe?: unknown } | undefined)?.subscribe;
          if (!hasPaseoCallTiming() || subscribing) return fn.apply(target, args);
          return paseoCall(() => fn.apply(target, args) as Promise<unknown>);
        }
        : fn.bind(target);
      members.set(prop, { fn: value, member });
      return member;
    },
  });
}
