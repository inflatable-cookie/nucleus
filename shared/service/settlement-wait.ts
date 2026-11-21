/** An approved lead submission waits for its durable operation to answer. */
export function waitsForSettlement(method: string | undefined): boolean {
  return method === "lead.submit";
}
