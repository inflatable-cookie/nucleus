export function selectTests(changed: string[], inputs: Map<string, Set<string>>, sources: Map<string, string>): { full: boolean; files: string[]; reasons: Map<string, string[]> };
export const SERIAL_LANE_MARKER: "./support/timing";
export function isSerialLaneSource(source: string): boolean;
export function entrySource(source: string, read: (path: string) => string): string;
