# 027 Driver Registry And Fixture Surfaces

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../008-scm-forge-driver-runway.md`

## Purpose

Add the first metadata-only SCM and forge driver registry surfaces.

The registry should prove that Nucleus can list and resolve driver descriptors
without starting real provider processes, touching working trees, calling
networks, or requiring credentials.

## Scope

- Add small registry and descriptor types for SCM drivers.
- Add small registry and descriptor types for forge drivers.
- Keep SCM and forge descriptors separate but linkable.
- Add static fixture descriptors for Git, Convergence, and GitHub where useful.
- Include provider kind, readiness, capabilities, workflow semantics, command
  scope needs, and implementation status.
- Add focused tests for descriptor registration and lookup.

## Acceptance Criteria

- SCM drivers can be listed independently from forge drivers.
- Git and Convergence SCM descriptors can coexist in one registry.
- GitHub or another forge descriptor can exist without being mistaken for an
  SCM driver.
- Registry tests do not require local Git repositories, credentials, network
  access, or Convergence runtime state.

## Validation

- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if descriptor work starts requiring live provider binaries.
- Stop if registry code begins to own runtime process lifecycle.

## Outcome

Added a metadata-only SCM/forge driver registry in
`crates/nucleus-scm-forge/src/registry.rs`.

Static descriptors now cover Git SCM semantics, Convergence SCM semantics, and
GitHub forge semantics without requiring repositories, credentials, process
execution, or network access.
