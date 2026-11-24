export const SERIAL_LANE_SOURCE: "./support/timing";
export const MAX_AFFECTED: number;
export function isGraphNode(path: string): boolean;
export function isTestFile(path: string): boolean;
export function resolveLocal(known: Set<string>, from: string, specifier: string): string | null;
export function selectAffected(input: {
  changed: string[];
  files: Set<string>;
  sources: Map<string, string>;
  testFiles?: Iterable<string>;
  max?: number;
}): {
  tests: { file: string; reasons: string[] }[];
  deferred: { file: string; reasons: string[] }[];
  unmapped: string[];
  serial: string[];
};
export function readBlobs(ref: string, paths: string[]): Map<string, string>;
export function readRepository(base: string, head: string, paths?: string[] | null): {
  changed: string[];
  files: Set<string>;
  sources: Map<string, string>;
  testFiles: string[];
};
