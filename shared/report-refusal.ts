import { formatSchemaRefusal } from "./schema-refusal";
import {
  REPORT_FIELD_ALIASES,
  REPORT_SHAPE_EXAMPLE,
} from "./service/report-usage.mjs";

type Issue = {
  code?: string;
  path?: Array<string | number>;
  message: string;
  keys?: string[];
};

const COMMIT_FIELDS = new Set(["head", "closeoutCommit"]);

/**
 * A refused report, worded so the sender can fix it in one step: each wrong field
 * names the field the schema takes, a missing one says it is missing, a commit
 * field says it wants the full SHA, and the accepted shape follows. The helper
 * route also points at `nucleus helper report --help`.
 */
export function formatReportRefusal(
  error: unknown,
  { helper = false }: { helper?: boolean } = {},
): string {
  const issues = (error as { issues?: Issue[] })?.issues;
  const lines = Array.isArray(issues)
    ? issues.flatMap(reportIssueLines)
    : [formatSchemaRefusal(error)];
  return [
    `Report refused: ${lines.join("; ")}.`,
    `Expected shape: ${REPORT_SHAPE_EXAMPLE}.`,
    ...(helper ? ["Run nucleus helper report --help for every field."] : []),
  ].join(" ");
}

function reportIssueLines(issue: Issue): string[] {
  const path = issue.path ?? [];
  const field = path.map(String).join(".");
  if (issue.code === "unrecognized_keys" && issue.keys?.length)
    return issue.keys.map((key) => {
      const instead =
        path.length === 0
          ? (REPORT_FIELD_ALIASES as Record<string, string>)[key]
          : undefined;
      const where = field ? `${field}.${key}` : key;
      return instead
        ? `${where} is not a report field; use "${instead}"`
        : `${where} is not a report field`;
    });
  if (/received undefined/.test(issue.message))
    return [`${field || "input"} is missing (${formatSchemaRefusal({ issues: [issue] })})`];
  if (path.length === 1 && COMMIT_FIELDS.has(field))
    return [
      `${field} must be the full 40-character lowercase commit SHA (field "${field}")`,
    ];
  return [formatSchemaRefusal({ issues: [issue] })];
}
