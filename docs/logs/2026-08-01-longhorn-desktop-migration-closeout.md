# Longhorn Desktop Migration Closeout

Date: 2026-08-01
Status: accepted
Scope: Longhorn g01.014 Card 101

## Outcome

Nucleus now consumes the shared desktop mechanisms without adopting the
optional hosted-Surface hierarchy. Its composition is `display -> window ->
region -> panel`.

Longhorn owns:

- storage profile resolution and receipted storage transitions
- display correlation, window placement, and protected primary-window hosting
- registered layout mutation and checked renderer reconciliation
- native-content island lifecycle and child-view coordination

Nucleus retains:

- projects, tasks, resources, panel catalogue, and project selection
- project-keyed panel presentations and product defaults
- Browser URL, navigation, trust, data-store, toolbar, and capability policy
- Tauri command composition and product-facing error handling

Poodle retains visual Surface primitives and public overlay-geometry events.
Those names do not represent a Longhorn Surface host, dependency, state model,
or command in Nucleus.

## Restart And Recovery

Fresh portable profiles resolve the same layout after restart. Platform-native
startup imports recognized `.nucleus` domains once, commits the locator last,
reuses the exact import receipt on restart, and leaves the source intact.
Interrupted storage, window, and project-layout migrations remain covered by
their receipt-bound recovery tests.

The retained `.nucleus` root is eligible for later cleanup only when the
operator presents the matching committed import receipt. This closeout does
not delete it.

## Retained Adapters

- `desktop_profile` selects Nucleus identity, profile, timeout, and proof input.
- `storage_migration` maps the old Nucleus store into shared transition domains.
- `window_host` maps the predeclared primary window into the shared host.
- `workspace_ui` maps product panels and legacy documents into registered
  layout documents.
- `browser_panel` maps Nucleus Browser policy into native-content islands.

The legacy workspace `Surface` structs remain decoder-only input for old saved
layouts. They have no runtime authority after decoding.

## Evidence

Longhorn Card 101 records the exact Nucleus, Longhorn, and Poodle source and
artifact identities, dependency and capability audits, restart matrix,
previous-build readback, conformance traces, and both repositories' Effigy QA.
Package-manager publication remains deferred.
