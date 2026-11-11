export function pathIsUnderDataHome(path: string, dataHome: string): boolean;
export function runIdMismatchRefusal(input: {
  toolName: string;
  boundRunId: string;
  namedRunId: string;
  kind: "report" | "ask" | "message";
  bindingUnderDataHome: boolean;
}): string;
