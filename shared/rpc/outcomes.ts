import { defineRpc } from "../rpc";
import { outcomeLookupSchema, outcomeSchema, outcomeSearchInputSchema, outcomeSearchResultSchema } from "../schema/outcomes";

export const outcome = defineRpc({ name: "queue.outcome", input: outcomeLookupSchema, output: outcomeSchema });

export const outcomeSearch = defineRpc({ name: "queue.outcome-search", input: outcomeSearchInputSchema, output: outcomeSearchResultSchema });
