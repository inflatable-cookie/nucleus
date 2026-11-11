/** Explicit settlement calls wait until the durable operation or QA run answers. */
export function waitsForSettlement(method: string | undefined, input: unknown): boolean {
  return method === 'lead.submit' || (method === 'project.qa.run' && (input as { wait?: boolean } | null)?.wait === true);
}
