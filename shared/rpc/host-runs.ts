import { defineRpc } from "../rpc";
import { z } from "zod";
import { hostRunAccountingDisposeInputSchema, hostRunAccountingListSchema, hostRunAccountingStatusInputSchema, hostRunAccountingViewSchema, hostRunBoardSchema, hostRunCapacityReleaseInputSchema, hostRunRecordSchema } from "../schema/host-runs";

export const hostRunList = defineRpc({ name: "host.run.list", input: z.object({}).strict(), output: z.array(hostRunRecordSchema) });

export const hostRunCapacityRelease = defineRpc({ name: "host.run.capacity.release", input: hostRunCapacityReleaseInputSchema, output: hostRunRecordSchema });

export const hostRunAccountingStatus = defineRpc({ name: "host.run.accounting.status", input: hostRunAccountingStatusInputSchema, output: hostRunAccountingViewSchema.nullable() });

/** Spec 035 "Retired runs on the board": the bounded bulk read beside the pinned host.run.list. */
export const hostRunAccountingList = defineRpc({ name: "host.run.accounting.list", input: z.object({}).strict(), output: hostRunAccountingListSchema });

export const hostRunBoard = defineRpc({ name: "host.run.board", input: z.object({}).strict(), output: hostRunBoardSchema });

export const hostRunAccountingDispose = defineRpc({ name: "host.run.accounting.dispose", input: hostRunAccountingDisposeInputSchema, output: hostRunAccountingViewSchema });
