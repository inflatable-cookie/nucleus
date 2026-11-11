/**
 * Generated operation identity for the legacy versioned task-control adapter.
 *
 * `queue.task` keeps its historical request and response shape, so it must
 * generate its own durable operation key. The readable prefix keeps task,
 * action and expected version; the suffix is the complete normalized control
 * digest acceptance fences on. A rejected control therefore never burns the
 * task/action/version namespace: identical input reconciles one operation after
 * a lost response, while a corrected instruction, hook, PR or disposition at
 * the unchanged task version receives a distinct deterministic identity.
 *
 * Explicit caller keys on `queue.operation-start` are untouched and still
 * reject different input under the same key.
 */
import { taskControlInputSchema, type TaskControlInput } from "../../shared/contracts";
import { operationInputHash } from "../store/store";

/** Caller operation keys are bounded at 200 characters by the operation contract. */
export const TASK_CONTROL_KEY_LIMIT = 200;

export interface TaskControlOperation {
  /** Deterministic generated key for the durable operation record. */
  key: string;
  /** Canonical durable payload, so the key digest and the stored input hash always agree. */
  payload: { type: "task_control"; control: TaskControlInput };
}

/**
 * Parse one control into its canonical normalized shape: schema field order,
 * and no field the caller left absent — an explicit `undefined` optional is the
 * same control as an omitted one. Identical input is therefore deterministic
 * however the caller spelled the request, and the payload matches the JSON the
 * operation record stores.
 */
export function normalizedTaskControl(input: TaskControlInput): TaskControlInput {
  const parsed = taskControlInputSchema.parse(input) as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const field of Object.keys(parsed)) if (parsed[field] !== undefined) normalized[field] = parsed[field];
  return normalized as TaskControlInput;
}

/**
 * One identity for one legacy task control: its readable key and the exact
 * canonical payload acceptance stores. The digest is the same normalized input
 * digest the operation record fences on, so key and stored input hash cannot
 * disagree. A readable prefix that cannot fit the caller-key bound fails closed
 * rather than truncating task identity.
 */
export function taskControlOperation(input: TaskControlInput): TaskControlOperation {
  const payload = { type: "task_control" as const, control: normalizedTaskControl(input) };
  const { taskId, action, version } = payload.control;
  const key = `task-control:${taskId}:${action}:${version}:${operationInputHash(payload)}`;
  if (key.length > TASK_CONTROL_KEY_LIMIT)
    throw new Error(`Task-control operation key exceeds the ${TASK_CONTROL_KEY_LIMIT}-character caller-key bound; Nucleus never truncates task identity`);
  return { key, payload };
}
