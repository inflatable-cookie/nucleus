# Release

## Changelog fragments

Pull requests add a Markdown fragment under `changelog.d/`; they do not edit
`CHANGELOG.md`'s `[Unreleased]` section. When cutting a release, collect and
review the fragments, curate their entries into a dated version section in
`CHANGELOG.md`, leave an empty `[Unreleased]`, and remove the folded fragment
files in the same release change. The folded changelog is that change’s release
record; it needs no additional fragment. This keeps parallel pull requests from
contending on the shared changelog.

## Local staging and activation

Stage the binary, browser board and Nucleus skill from one clean revision
using the [engine staging command](../../../engine/README.md#stage-an-engine-release).
Run [milestone QA](milestone-qa.md) against a published main commit. Keep
artifacts and private validation evidence in the configured scratch location.

Staging produces an inactive release. An authorized operator controls the service
roll. Preserve the existing profile, storage placement, credentials and dispatch
setting. For a schema change, pause dispatch and account for potentially sent
commands before switching. Confirm the service owns the listener, the schema
opens and the board pairs before restoring the prior dispatch state. Keep T3
and its daemon running. After a UI change, check the installed board in the
operator’s dark theme.

Releases move forward. Restoring an older database is an operator-directed
recovery with dispatch held until the later native effects are reconciled.
See [engine store recovery](../operations/restore.md).

## Public releases

Publishing, changing repository visibility and editing CI or release workflows
require operator authorization. Keep fixtures synthetic and private evidence out
of the published tree. Preserve the original tag and assets of a published
release. The Rust public packaging procedure remains an operator decision.

## Historical TypeScript runtime package

The macOS arm64 v0.1.0 package and its installer belonged to the retired
TypeScript engine. Its release and installation history is preserved in the
[release contract before retirement](https://github.com/inflatable-cookie/nucleus/blob/c1771a0651636cbf1a69e5309ea62fff055efd3d/docs/knowledge/contracts/release.md).
