import type { BoardAgentRecord, BoardAgentUpdate, BoardHost } from "./shell";

const observers = new WeakMap<BoardHost, { add(listener: (update: BoardAgentUpdate) => void): () => void }>();
/** One daemon inventory subscription for both composer contributions. */
export function observeAgents(client: BoardHost, listener: (update: BoardAgentUpdate) => void, retryMs = 4000): () => void {
  const existing = observers.get(client);
  if (existing) return existing.add(listener);
  const listeners = new Set<(update: BoardAgentUpdate) => void>();
  const agents = new Map<string, BoardAgentRecord>();
  const lifetime = new AbortController();
  let reading = false, following = false;
  let release: (() => void) | undefined;
  const apply = (update: BoardAgentUpdate) => {
    if (lifetime.signal.aborted) return;
    if (update.kind === "upsert") agents.set(update.agent.id, update.agent);
    else agents.delete(update.agentId);
    for (const notify of listeners) notify(update);
  };
  const replace = (entries: Array<{ agent: BoardAgentRecord }>) => {
    const keep = new Set(entries.map(({ agent }) => agent.id));
    for (const id of agents.keys()) if (!keep.has(id)) apply({ kind: "remove", agentId: id });
    for (const { agent } of entries) apply({ kind: "upsert", agent });
  };
  const unsubscribe = client.agents.subscribe?.(apply);
  const read = async () => {
    if (reading || following || lifetime.signal.aborted) return;
    reading = true;
    try {
      const list = await client.agents.list({ subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) { list.subscription?.release?.(); return; }
      release = () => { void list.subscription?.release?.(); };
      const entries = [...list.entries ?? []];
      let page = list;
      const cursors = new Set<string>();
      while (page.pageInfo?.hasMore) {
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor)) throw Error("Agent inventory is incomplete");
        cursors.add(cursor);
        page = await client.agents.list({ page: { limit: 100, cursor }, signal: lifetime.signal });
        entries.push(...page.entries);
      }
      replace(entries);
      following = Boolean(unsubscribe);
      if (list.subscription?.subscribe) {
        following = true;
        list.subscription.subscribe({ snapshot: snapshot => replace(snapshot.entries), update: message => { if (message.type === "agent_update") apply(message.payload); } });
      }
    } catch (error) { release?.(); release = undefined; if (!lifetime.signal.aborted) console.warn("[nucleus] agent inventory failed", error); }
    finally { reading = false; }
  };
  const timer = setInterval(() => void read(), retryMs);
  const observer = { add(notify: (update: BoardAgentUpdate) => void) {
    listeners.add(notify);
    for (const agent of agents.values()) notify({ kind: "upsert", agent });
    return () => {
      listeners.delete(notify);
      if (listeners.size) return;
      lifetime.abort(); clearInterval(timer); unsubscribe?.(); release?.(); observers.delete(client);
    };
  } };
  observers.set(client, observer);
  const stop = observer.add(listener);
  void read();
  return stop;
}
