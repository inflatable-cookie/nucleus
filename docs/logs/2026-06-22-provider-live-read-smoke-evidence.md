# 2026-06-22 Provider Live Read Smoke Evidence

## Summary

The first approved live provider read smoke completed against a public fixture
repository.

This was a manually approved read-only smoke through `gh`, not automatic UI
execution and not a provider-write path.

## Approval

Operator approved this exact read-only command:

```sh
gh repo view octocat/Hello-World --json nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt
```

Approved target:

- provider: GitHub
- host: `github.com`
- repo: `octocat/Hello-World`
- operation family: repository metadata refresh
- target refs: `remote-repo:octocat/Hello-World`
- credential lease metadata: local `gh` authenticated account, token material
  not recorded
- network-read authority: explicit operator approval in this session
- payload policy: sanitized selected fields only
- retention policy: no raw provider payload retention

## Evidence

Read-only command:

- `gh repo view octocat/Hello-World --json nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt`

Sanitized observed fields:

- repo: `octocat/Hello-World`
- visibility: public
- default branch: `master`
- viewer permission: read
- private: false
- URL: `https://github.com/octocat/Hello-World`
- pushed at: `2024-08-20T23:54:42Z`
- updated at: `2026-06-22T20:17:08Z`

## Boundary

No provider write was requested or performed.

No task mutation, callback execution, interruption execution, recovery
execution, merge, comment, label, status/check update, branch mutation, or raw
provider payload retention was requested or performed.

Credential material, authorization headers, raw response bodies, raw request
bodies, and raw headers were not recorded in project docs.

## Follow-Up

The smoke proves that a minimal read-only provider request can succeed with the
local `gh` credential context and fixed field selection.

It does not prove automatic UI-triggered provider execution, provider writes,
task mutation, callback execution, interruption/recovery execution, or raw
payload retention. The next implementation lane should promote this smoke into
the server-owned executor evidence model without broadening provider authority.
