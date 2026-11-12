Client screens now read the shared design tokens: every font size, corner radius
and spacing value comes from `client/design.ts`, and every colour from the host
theme or the overlay token. A new `test/client-design-tokens` check flags a fresh
`fontSize`, `borderRadius` or hex colour literal in a screen file.
