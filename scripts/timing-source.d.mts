export const SERIAL_LANE_MARKER: string;
export function isSerialLaneSource(source: string): boolean;
export function entrySource(source: string, read: (path: string) => string): string;
export function selectTimingFiles(requested: string[], available: string[], read: (path: string) => string): string[];
