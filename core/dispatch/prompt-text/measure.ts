import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnedJson } from '../../machine/owned-file.mjs';
/** A prompt measurement contains counts only, never prompt text or credentials. */
export interface PromptSize {
  total: number;
  sections: Record<string, number>;
}

export interface WorkerPromptMeasurement {
  primary: PromptSize;
  fallback: PromptSize;
  affectedTestsCommand?: string;
}

const sectionNames = [
  'identity', 'workspace', 'brief', 'lane', 'laneDocuments', 'validation',
  'namedProof', 'proofFiles', 'standingRules', 'contextIndex', 'history',
  'recoverySnapshot', 'report', 'roleInstructions',
] as const;
type SectionName = Exclude<typeof sectionNames[number], 'roleInstructions'>;
export type PromptSection = (name: SectionName, text: string) => string;
export const unmeasuredSection: PromptSection = (_name, text) => text;

/** Render once and count the sections where the renderers actually emit them. */
export function measureRunPrompt(render: (section: PromptSection) => string): { prompt: string; size: PromptSize } {
  const sections: Record<string, number> = {};
  let labeled = 0;
  const prompt = render((name, value) => {
    if (value.length) sections[name] = (sections[name] ?? 0) + value.length;
    labeled += value.length;
    return value;
  });
  if (labeled !== prompt.length) sections.roleInstructions = prompt.length - labeled;
  return { prompt, size: { total: prompt.length, sections } };
}

/** Write only character counts for the exact launch attempt, never prompt text. */
export function writePromptSize(directory: string, runId: string, role: string, size: PromptSize): void {
  writeOwnedJson(join(directory, 'nucleus-prompt-size.json'), { runId, role, ...size });
}

/** A failed or missing telemetry read must not turn a sent prompt into a retry. */
export function recordPromptSize(store: { event(taskId: string, kind: string, detail: string): unknown }, taskId: string, runId: string, directory?: string): void {
  if (!directory) return;
  try {
    const result = JSON.parse(readFileSync(join(directory, 'nucleus-prompt-size.json'), 'utf8'));
    const names = [...sectionNames, 'other']; // Accept records left by an earlier launcher.
    if (result.runId !== runId || !['worker', 'revision', 'reviewer', 'recovery', 'executor', 'closeout'].includes(result.role) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > 10_000_000 || !result.sections || typeof result.sections !== 'object') return;
    const sections: Record<string, number> = {};
    for (const name of names) {
      const value = result.sections[name];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > result.total) return;
      sections[name] = value;
    }
    if (Object.values(sections).reduce((a, b) => a + b, 0) !== result.total) return;
    store.event(taskId, 'prompt_size', JSON.stringify({ runId, role: result.role, total: result.total, sections }));
  } catch { /* telemetry cannot change delivery state */ }
}
