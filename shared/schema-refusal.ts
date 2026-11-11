/** One-line schema refusals: name the field and the expected shape. */

type SchemaIssue = {
  code?: string;
  path?: Array<string | number>;
  message: string;
  keys?: string[];
  expected?: unknown;
  values?: unknown[];
  errors?: SchemaIssue[][];
};

export function formatSchemaRefusal(error: unknown): string {
  const issues = Array.isArray((error as { issues?: unknown })?.issues)
    ? (error as { issues: SchemaIssue[] }).issues
    : null;
  if (!issues?.length) return error instanceof Error ? error.message : String(error);
  return issues.map(formatSchemaIssue).join("; ");
}

export function parseContractValue<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) { throw new Error(formatSchemaRefusal(error)); }
}

function formatSchemaIssue(issue: SchemaIssue): string {
  if (issue.code === "unrecognized_keys" && issue.keys?.length)
    return issue.keys.map(key => `${key}: unrecognized key`).join("; ");
  const field = (issue.path ?? []).map(String).join(".");
  const expected = expectedShape(issue);
  if (expected) return `${field || "input"}: expected ${expected}`;
  if (issue.code === "invalid_union" && issue.errors?.length) {
    const branches = issue.errors.map(branch => branch.map(child => formatSchemaIssue({ ...child,
      path: [...(issue.path ?? []), ...(child.path ?? [])] })).join("; "));
    return [...new Set(branches)].join(" or ");
  }
  if (issue.code === "invalid_value" && issue.values?.length)
    return `${field || "input"}: expected ${issue.values.map(value => JSON.stringify(value)).join(" or ")}`;
  return field ? `${field}: ${issue.message}` : issue.message;
}

function expectedShape(issue: SchemaIssue): string | undefined {
  const fromMessage = issue.message.match(/^expected (.+)$/i)?.[1]
    ?? issue.message.match(/^Invalid input: expected ([^,]+)(?:, received .+)?$/)?.[1];
  if (fromMessage) return fromMessage;
  return typeof issue.expected === "string" ? issue.expected : undefined;
}
