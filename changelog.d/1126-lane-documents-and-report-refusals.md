Briefs can cite lane documents by key in prose or a `## Read` list. Nucleus pins
and gives each role a read-only scratch copy, and names unresolved references in
the prompt. Continuations refresh cited documents when their version changes.

Malformed worker reports now return a field-specific refusal and keep the turn
open for correction and resend; the worker prompt says not to turn its own
refusal into a blocked outcome.
