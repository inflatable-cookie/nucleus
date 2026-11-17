/**
 * The forked sidebar's one read (Spec 062, decision 5b) and the board signal it
 * refetches on.
 *
 * The sidebar is a plugin surface, so the read is a plugin RPC method,
 * `sidebarGroups`, served by this plugin's backend and forwarded over the existing
 * owner socket to the Nucleus service's catalogue method `bb.sidebar-groups`. That
 * is one call for every Nucleus task group, never one per group, and it reads no
 * forge, no Git and no thread timeline: the service answers from the live task
 * records and the BB workspace handles it already owns.
 *
 * The projection is validated at both ends. It cannot import the service's own
 * schema (a BB plugin is built from its own directory), so the schema is declared
 * here and `test/bb-sidebar-groups.test.ts` parses one recorded answer through
 * both, which fails the affected run if the two ever drift.
 *
 * Live updates ride one realtime signal: the backend watches the service's board
 * revision on the retained connection and publishes `nucleus.board-signal` when it
 * moves, and the sidebar refetches this one read when it arrives. A signal that
 * never arrives costs a stale header, never a second polling loop in the UI.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The service catalogue method this plugin forwards to (Contract 007). */
export const SIDEBAR_GROUPS_METHOD = "bb.sidebar-groups";

/** The realtime channel a board revision change is published on. */
export const BOARD_SIGNAL_CHANNEL = "nucleus.board-signal";

export const sidebarGroupSchema = z.object({
  environmentId: z.string().min(1).max(240),
  taskId: z.string().min(1).max(240),
  number: z.number().int().positive().nullable(),
  reference: z.string().nullable(),
  title: z.string().min(1),
  phase: z.string().min(1).max(60),
  phaseLabel: z.string().min(1).max(240),
  stateLabel: z.string().min(1).max(240),
  waitLabel: z.string().min(1).max(240).nullable(),
  prNumber: z.number().int().positive().nullable(),
  prState: z.enum(["OPEN", "CLOSED", "MERGED"]).nullable(),
  prUrl: z.string().max(2048).nullable(),
  attention: z.boolean(),
  held: z.boolean(),
  stop: z.string().min(1).max(60).nullable(),
}).strict();

export const sidebarGroupsOutputSchema = z.object({
  groups: z.array(sidebarGroupSchema),
  threads: z.array(z.object({
    threadId: z.string().min(1).max(240),
    taskId: z.string().min(1).max(240),
    role: z.string().min(1).max(80),
    environmentId: z.string().min(1).max(240),
  }).strict()),
}).strict();

export type SidebarGroup = z.infer<typeof sidebarGroupSchema>;
export type SidebarGroups = z.infer<typeof sidebarGroupsOutputSchema>;

/** The plugin's own RPC method names, registered in `server.ts` and read by the fork. */
export const sidebarGroupsContract = defineRpcContract({
  sidebarGroups: { input: z.null(), output: sidebarGroupsOutputSchema },
});

/** One bounded service request, as the retained channel offers it. */
export interface SidebarGroupsSource {
  request(method: string, input: unknown): Promise<unknown>;
}

/**
 * The RPC handler. A read that cannot reach the service rejects: the sidebar then
 * keeps (or falls back to) upstream's group header, which is the stated
 * degradation, never a blocked sidebar or an invented state line.
 */
export function createSidebarGroupsService(source: () => SidebarGroupsSource | null) {
  return {
    async sidebarGroups(): Promise<SidebarGroups> {
      const client = source();
      if (!client) throw new Error("The Nucleus service channel is not connected");
      return sidebarGroupsOutputSchema.parse(await client.request(SIDEBAR_GROUPS_METHOD, null));
    },
  };
}
