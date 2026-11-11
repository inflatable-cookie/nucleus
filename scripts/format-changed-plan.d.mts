export interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ChangedRegion {
  line: number;
  count: number;
}

export interface LineInterval {
  start: number;
  end: number;
}

export interface FormattingPlan {
  safe: boolean;
  text?: string;
  drift?: number[];
  reason?: "diff-failed";
  detail?: string;
}

export function unifiedHunks(diffText: string): UnifiedHunk[];
export function changedRegionsFromDiff(diffText: string): Map<string, ChangedRegion[]>;
export function expandedIntervals(regions: ChangedRegion[], slack: number): LineInterval[];
export function hunkIsContained(hunk: UnifiedHunk, intervals: LineInterval[]): boolean;
export function gitUnifiedDiff(left: string, right: string): string;
export function formattingPlan(options: {
  current: string;
  formatted: string;
  regions: ChangedRegion[];
  slack: number;
  runUnifiedDiff: (left: string, right: string) => string;
}): FormattingPlan;
