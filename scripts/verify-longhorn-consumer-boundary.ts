import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const longhornRoot = resolve(repoRoot, "../longhorn");

const rendererPackages = {
  "@longhorn/commands": "commands",
  "@longhorn/config": "config",
  "@longhorn/core": "core",
  "@longhorn/layout": "layout",
  "@longhorn/native-content": "native-content",
  "@longhorn/native-content-svelte": "native-content-svelte",
  "@longhorn/notifications": "notifications",
  "@longhorn/operation": "operation",
  "@longhorn/poodle": "poodle",
  "@longhorn/settings": "settings",
  "@longhorn/svelte": "svelte",
} as const;

const rustCrates = [
  "longhorn-bridge",
  "longhorn-command",
  "longhorn-command-config",
  "longhorn-command-settings",
  "longhorn-config",
  "longhorn-core",
  "longhorn-display",
  "longhorn-layout",
  "longhorn-layout-config",
  "longhorn-native-content",
  "longhorn-notifications",
  "longhorn-operation",
  "longhorn-settings",
  "longhorn-settings-config",
  "longhorn-tauri-config",
  "longhorn-tauri-bridge",
  "longhorn-tauri-command",
  "longhorn-tauri-native-content-child-view",
  "longhorn-tauri-notifications",
  "longhorn-tauri-operation",
  "longhorn-tauri-settings",
  "longhorn-tauri-windowing",
  "longhorn-windowing",
  "longhorn-windowing-config",
] as const;

const selectedLonghornSources = [
  "Cargo.toml",
  "Cargo.lock",
  ...Object.values(rendererPackages).map((path) => `packages/${path}`),
  ...rustCrates.map((name) => `crates/${name}`),
] as const;

const forbiddenRendererPackages = [
  "@longhorn/history",
  "@longhorn/surface-transfer",
  "@longhorn/surfaces",
] as const;
const forbiddenRustCrates = [
  "longhorn-history",
  "longhorn-surface-transfer",
  "longhorn-surface-windowing",
  "longhorn-surfaces",
] as const;

const manifest = JSON.parse(
  readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
) as PackageManifest;

const longhornCommit = command(longhornRoot, ["git", "rev-parse", "HEAD"]);
const selectedStatus = command(longhornRoot, [
  "git",
  "status",
  "--porcelain",
  "--",
  ...selectedLonghornSources,
]);
assert(!selectedStatus, `selected Longhorn sources are dirty:\n${selectedStatus}`);

const selectedTree = command(longhornRoot, [
  "git",
  "ls-tree",
  "-r",
  "HEAD",
  "--",
  ...selectedLonghornSources,
]);

for (const [name, sourceDirectory] of Object.entries(rendererPackages)) {
    const expected = `file:../../../longhorn/packages/${sourceDirectory}`;
    assert(manifest.dependencies?.[name] === expected, `${name} source mismatch`);
    assert(manifest.overrides?.[name] === expected, `${name} override mismatch`);
}

for (const name of forbiddenRendererPackages) {
  assert(!manifest.dependencies?.[name], `forbidden renderer dependency ${name}`);
  assert(!manifest.overrides?.[name], `forbidden renderer override ${name}`);
  assert(!existsSync(resolve(desktopRoot, "node_modules", ...name.split("/"))), `${name} installed`);
}

const rendererArtifactProof = verifyRendererArtifacts();

const cargoTree = command(repoRoot, [
  "cargo",
  "tree",
  "-p",
  "nucleus-desktop",
  "--edges",
  "normal",
  "--prefix",
  "none",
]);
const installedRust = rustCrates.map((name) => {
  const versions = new Set(
    cargoTree
      .split("\n")
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.split(" ")[1]),
  );
  assert(versions.size === 1, `${name} resolved ${versions.size} versions`);
  return { name, version: [...versions][0] };
});
for (const name of forbiddenRustCrates) {
  assert(!cargoTree.includes(`${name} `), `forbidden Rust dependency ${name}`);
}

const lifecycleEvidence = [
  [
    "apps/desktop/src-tauri/src/desktop_profile/tests.rs",
    "fresh_portable_profile_restarts_with_the_same_layout",
  ],
  [
    "apps/desktop/src-tauri/src/storage_migration/tests.rs",
    "corrupt_and_future_ui_preserve_source_and_never_commit_locator",
  ],
  [
    "apps/desktop/src-tauri/src/window_host/migration.rs",
    "published_domain_without_receipt_resumes_receipt_completion_only",
  ],
  [
    "apps/desktop/src-tauri/src/tests/panel_guards.rs",
    "product_workspace_uses_checked_longhorn_regions_without_surfaces",
  ],
  [
    "apps/desktop/src-tauri/src/settings/tests.rs",
    "stale_authority_conflicts_without_overwriting_and_restart_reloads_commit",
  ],
  [
    "apps/desktop/src-tauri/src/commands/tests.rs",
    "stale_projection_cannot_authorize_a_now_clean_editor",
  ],
  [
    "apps/desktop/src-tauri/src/operations/tests.rs",
    "running_work_becomes_sticky_terminal_without_product_payloads",
  ],
  [
    "apps/desktop/src-tauri/src/notifications/tests.rs",
    "operation_failure_is_redacted_and_routes_through_semantic_action",
  ],
  [
    "apps/desktop/src-tauri/src/config_operations/tests.rs",
    "selected_operational_archive_exports_the_exact_snapshot_as_user_export",
  ],
  [
    "apps/desktop/src-tauri/src/bridge/tests.rs",
    "registered_tauri_commands_preserve_direct_local_bridge_semantics",
  ],
] as const;
for (const [path, evidence] of lifecycleEvidence) {
  assert(
    readFileSync(resolve(repoRoot, path), "utf8").includes(evidence),
    `missing conformance evidence ${evidence}`,
  );
}

console.log(
  JSON.stringify(
    {
      schema: "nucleus.longhorn-consumer-boundary.v1",
      outcome: "pass",
      source: {
        commit: longhornCommit,
        selectedTreeSha256: sha256(selectedTree),
        selectedSourcesClean: true,
        siblingWorktreeMayContainUnrelatedChanges: true,
      },
      renderer: {
        ...rendererArtifactProof,
        forbiddenPackagesAbsent: forbiddenRendererPackages,
      },
      rust: {
        crates: installedRust,
        forbiddenCratesAbsent: forbiddenRustCrates,
      },
      adapters: {
        storageProfile: "desktop_profile::{host,validation}",
        storageTransition:
          "storage_migration::adapters::{sqlite,tree,ui}",
        protectedWindow: "window_host",
        projectLayout: "workspace_ui::runtime::project_documents",
        nativeBrowser: "browser_panel",
        settings: "settings::{registry,authority,consumer-pages}",
        commands: "commands::{catalogue,keymap,runtime}",
        operations: "operations",
        notifications: "notifications",
        backup: "config_operations::{authority,backup_domains,export}",
        localBridge: "bridge",
      },
      productAuthority: {
        owner: "Nucleus",
        contract: "docs/contracts/032-longhorn-desktop-systems-integration-contract.md",
        nextEdge:
          "grouped custom-adapter restore plus Nucleus boot-time quiescence and restart handoff",
      },
      lifecycleEvidence: lifecycleEvidence.map(([path, evidence]) => ({ path, evidence })),
    },
    null,
    2,
  ),
);

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

interface ArtifactEvidence {
  artifactSetId: string;
  artifacts: Array<{
    name: string;
    version: string;
    filename: string;
    sha256: string;
  }>;
}

function command(cwd: string, argv: readonly string[]): string {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function verifyRendererArtifacts() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "nucleus-longhorn-consumer-"));
  try {
    const resolvedTemporaryRoot = realpathSync(temporaryRoot);
    const packs = resolve(temporaryRoot, "packs");
    const consumer = resolve(temporaryRoot, "consumer");
    mkdirSync(packs);
    mkdirSync(consumer);

    const longhornArtifacts: Record<string, string> = {};
    const longhornIdentities = Object.entries(rendererPackages).map(
      ([name, sourceDirectory]) => {
        command(resolve(longhornRoot, "packages", sourceDirectory), [
          "bun",
          "pm",
          "pack",
          "--destination",
          packs,
          "--ignore-scripts",
          "--quiet",
        ]);
        const filename = `${name.replace("@", "").replace("/", "-")}-0.1.0.tgz`;
        const path = resolve(packs, filename);
        assert(existsSync(path), `${name} artifact was not produced`);
        const listing = command(packs, ["tar", "-tzf", path]);
        assert(!listing.includes("node_modules/"), `${name} artifact contains node_modules`);
        assert(!listing.includes("workspace:"), `${name} artifact contains a workspace alias`);
        longhornArtifacts[name] = `file:${path}`;
        return { name, version: "0.1.0", filename, sha256: sha256(readFileSync(path)) };
      },
    );

    const workspaceManifest = JSON.parse(
      readFileSync(resolve(longhornRoot, "package.json"), "utf8"),
    ) as PackageManifest & { devDependencies?: Record<string, string> };
    const poodleRef = workspaceManifest.devDependencies?.["@poodle/headless"];
    assert(poodleRef?.startsWith("file:"), "Longhorn Poodle artifact reference is missing");
    const poodlePack = resolve(longhornRoot, poodleRef.slice("file:".length));
    const poodlePackRoot = dirname(poodlePack);
    const poodleEvidence = JSON.parse(
      readFileSync(resolve(poodlePackRoot, "../evidence.json"), "utf8"),
    ) as ArtifactEvidence;
    const poodleArtifacts: Record<string, string> = {};
    for (const artifact of poodleEvidence.artifacts) {
      const path = resolve(poodlePackRoot, artifact.filename);
      assert(sha256(readFileSync(path)) === artifact.sha256, `${artifact.name} digest mismatch`);
      poodleArtifacts[artifact.name] = `file:${path}`;
    }

    const dependencies = {
      ...longhornArtifacts,
      ...poodleArtifacts,
      svelte: "5.56.8",
    };
    writeFileSync(
      resolve(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "nucleus-longhorn-consumer-proof",
          private: true,
          dependencies,
          overrides: dependencies,
        },
        null,
        2,
      )}\n`,
    );
    command(consumer, ["bun", "install", "--ignore-scripts"]);

    const packageManifests = command(consumer, [
      "find",
      "node_modules",
      "-type",
      "f",
      "-name",
      "package.json",
    ])
      .split("\n")
      .filter(Boolean)
      .map((path) => {
        const absolute = resolve(consumer, path);
        const value = JSON.parse(readFileSync(absolute, "utf8")) as PackageManifest;
        return { name: value.name, root: realpathSync(dirname(absolute)) };
      });
    const svelteRuntime = packageManifests.filter(({ name }) => name === "svelte");
    const poodleRuntime = packageManifests.filter(({ name }) => name === "@poodle/svelte");
    assert(svelteRuntime.length === 1, `artifact graph has ${svelteRuntime.length} Svelte runtimes`);
    assert(poodleRuntime.length === 1, `artifact graph has ${poodleRuntime.length} Poodle runtimes`);
    for (const name of Object.keys(rendererPackages)) {
      const root = resolve(consumer, "node_modules", ...name.split("/"));
      assert(existsSync(root), `${name} artifact is not installed`);
      assert(!lstatSync(root).isSymbolicLink(), `${name} artifact install is a symlink`);
      const resolvedRoot = realpathSync(root);
      assert(
        resolvedRoot.startsWith(resolvedTemporaryRoot),
        `${name} resolved outside proof root: ${resolvedRoot}`,
      );
    }
    for (const name of forbiddenRendererPackages) {
      assert(
        !existsSync(resolve(consumer, "node_modules", ...name.split("/"))),
        `${name} resolved in artifact graph`,
      );
    }

    return {
      packages: longhornIdentities,
      poodleArtifactSet: poodleEvidence.artifactSetId,
      producedArtifactsInstalledOutsideWorkspace: true,
      svelteRuntime: svelteRuntime.map(({ root }) =>
        root.replace(resolvedTemporaryRoot, "<proof>"),
      ),
      poodleRuntime: poodleRuntime.map(({ root }) =>
        root.replace(resolvedTemporaryRoot, "<proof>"),
      ),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
