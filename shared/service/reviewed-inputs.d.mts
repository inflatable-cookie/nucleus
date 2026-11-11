export const REVIEWED_INPUT_SHAPES: string;
export const REVIEWED_INPUT_RESEND_RULE: string;
export function reviewedInputPathProblem(path: unknown): string | null;
export function reviewedInputEntryRefusal(entry: unknown): string | null;
export function dedupeReviewedInputs<T>(rows: T[]): T[];
export function reviewedInputListRefusals(rows: unknown): { path: (string | number)[]; message: string }[];
