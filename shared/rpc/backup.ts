import { defineRpc } from "../rpc";
import { z } from "zod";
import { backupListSchema } from "../schema/backup";

export const backupNow = defineRpc({ name: 'backup.now', input: z.object({}).strict(), output: backupListSchema });

export const backupList = defineRpc({ name: 'backup.list', input: z.object({}).strict(), output: backupListSchema });
