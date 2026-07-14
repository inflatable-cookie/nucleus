# 004 Display Window Surface Layout

Status: superseded
Owner: Tom
Updated: 2026-07-13

## Outcome

This spec originally proposed:

```text
display -> window -> surface -> region -> panel
```

Product use showed that hosted Surfaces duplicated project switching and panel
tabs without providing a distinct Nucleus workflow. The accepted model is:

```text
display -> window -> region -> panel
```

Durable authority:

- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../008-window-region-panel-simplification.md`

The useful inherited concepts remain stable display identity, window placement,
display fallback, semantic regions, and panel placement policy. Hosted-Surface
identity, lifecycle, ordering, attachments, and tabs are removed.
