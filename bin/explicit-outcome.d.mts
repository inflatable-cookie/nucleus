export declare const EXPLICIT_COMMANDS: string[];
export declare const NOT_APPLIED_EXIT_CODE: 2;
export declare const PLANNER_ONLY_WARNING_IDS: string[];
export declare const OPERATOR_ONLY_WARNING_IDS: string[];
export declare function explicitOutcome(result: unknown): { line: string; exitCode: number } | null;
