/** Node test reporter: one per-file duration table, slowest first, when the run ends. */
export default function durations(source: AsyncIterable<{ type: string; data?: Record<string, unknown> }>): AsyncGenerator<string>;
export function durationTablePath(): string;
export function durationReporterArgs(tty?: boolean): string[];
export function flushDurationTable(destination: string): void;
export function failureSummaryPath(): string;
export function flushFailureSummary(destination: string): void;
