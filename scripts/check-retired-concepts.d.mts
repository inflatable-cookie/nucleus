export interface RetiredFinding {
  id: string;
  kind: string;
  needle: string;
  file: string;
  text?: string;
  line?: number;
}
export function newFindings<T extends RetiredFinding>(findings: T[], baseline: Record<string, number>): T[];
