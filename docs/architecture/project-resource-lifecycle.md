# Project Resource And Lifecycle Architecture

Status: accepted direction
Owner: Tom
Updated: 2026-07-15

## Project Boundary

A project is the Nucleus-owned logical scope for conversations, goals, tasks,
memory, resources, and workspace preferences.

Project identity does not depend on a repository, folder, checkout, or
management projection. Zero-resource projects are valid.

## Authority Shape

The authoritative engine host owns project records and mutations through the
server boundary. Clients render projections and submit typed commands.

Filesystem locations belong to the host that can resolve them. A remote
project resource therefore carries host authority and a host-local locator;
the desktop client does not convert it into a local path.

## Resource Shape

Projects contain zero or more stable resource memberships.

The initial kinds are plain filesystem folders and Git repositories. Git
resources add remote, branch, and repository identity hints without making Git
mandatory. Resource roles express working, management, or reference intent.

Location and Git metadata may change without changing the resource or project
identity. Repair updates membership state and retains useful location history.

The realized mutation boundary is one typed project-resource command family.
The authoritative host detects plain folders versus Git worktrees, canonicalizes
host-local locators, persists exact-revision changes and receipts, and never
deletes operator files when a membership is removed.

## Runtime Targeting

Filesystem-dependent panels and agent work target a resource, not a project
path. A project-level default resource provides the common case without
removing explicit targeting from the host API.

The operator terminal can also run for a zero-resource project. Its
authoritative host chooses the host user's home directory as the initial
working directory; the client does not supply a path and the fallback does not
become a project resource. A configured but unavailable default resource
remains a visible repair error rather than silently falling back.

Panels remain visually simple. They show a resource selector only when the
project has multiple compatible choices or when the current choice needs
repair.

## Lifecycle Shape

Project visibility and retention are independent:

- active, parked, and archived control normal product visibility
- transient and durable control retention policy

New unscoped chats use transient projects. Promotion changes retention in
place and preserves all owned identities. Durable child records cannot remain
under a silently expiring parent.

The first realized lifecycle slice creates durable zero-resource projects by
name. One typed server command family covers rename, park, archive, restore,
and guarded delete. Exact revisions, project-metadata host authority, and
durable idempotency receipts keep desktop controls thin. Delete fails closed
when retained project work exists or cannot be inspected safely.

## Projection Shape

Shared project files are an optional Git-backed projection of selected shared
intent. The server store remains authoritative.

The first implementation permits one active management projection targeting a
Git resource. This restriction is a sync-coherence boundary, not a claim that
the project has one canonical code repository.

## Product Shape

The primary workflow offers immediate new chat, name-only new project, and
open-folder-or-repository actions. Resource management, defaults, repair,
retention, and shared-project-file controls live behind project menus and
popovers.

The project rail now implements the name-only durable path. Lifecycle actions
stay behind each project's overflow menu, with inline conflict and refusal
feedback instead of a setup wizard or modal sequence.

The same overflow menu opens a compact resource subview. Native folder
selection supplies a locator to the authoritative host, which detects folder
or Git kind and owns attach, default, repair, and removal mutations. Panels
show resource controls only when multiple working choices or repair require
operator input; their per-project choice persists in workspace UI config.

The working rail contains active projects only. A compact project-management
dialog owns the all, parked, and archived views plus restore and other
lifecycle actions. Parking or archiving therefore removes a project from
normal focus without making it undiscoverable.
