export const SERIAL_LANE_SOURCE: "./support/timing";
export function isGraphNode(path: string): boolean;
export function isTestFile(path: string): boolean;
export function resolveLocal(known: Set<string>, from: string, specifier: string): string | null;
export function selectAffected(input: {
  changed: string[];
  files: Set<string>;
  sources: Map<string, string>;
}): {
  tests: { file: string; reasons: string[] }[];
  unmapped: string[];
  serial: string[];
};
export function readBlobs(ref: string, paths: string[]): Map<string, string>;
export function readRepository(base: string, head: string, paths?: string[] | null): {
  changed: string[];
  files: Set<string>;
  sources: Map<string, string>;
};
