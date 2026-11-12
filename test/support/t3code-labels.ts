import { readFileSync } from 'node:fs';
import { NUCLEUS_LABEL_KEYS } from '../../shared/wire-labels';

/** Stored launch-label shapes, with synthetic values and no private identities. */
const shapes = JSON.parse(readFileSync(new URL('../fixtures/t3code-stored-labels.json', import.meta.url), 'utf8')) as
  Record<'worker' | 'recovery' | 'reviewer', Record<string, string>>;

/** Workers have no role label; support launches add their role to the same shape. */
export function storedT3Labels(role: string, identity: { taskId?: string; runId?: string } = {}): Record<string, string> {
  const shape = role === 'worker' ? shapes.worker : role === 'reviewer' ? shapes.reviewer : shapes.recovery;
  const labels: Record<string, string> = { ...shape,
    [NUCLEUS_LABEL_KEYS.task]: identity.taskId ?? 'synthetic-task',
    [NUCLEUS_LABEL_KEYS.run]: identity.runId ?? `synthetic-${role}-run` };
  if (role !== 'worker') labels[NUCLEUS_LABEL_KEYS.role] = role;
  return labels;
}
