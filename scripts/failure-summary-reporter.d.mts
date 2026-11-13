/** Node test reporter that saves failing test file and name pairs outside the console stream. */
export default function failureSummary(source: AsyncIterable<{ type: string; data?: Record<string, unknown> }>): AsyncGenerator<string>;
export function failureSummaryArgs(): string[];
export function failureSummaryPath(): string;
export function flushFailureSummary(destination: string): void;
