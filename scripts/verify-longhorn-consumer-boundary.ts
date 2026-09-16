import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");

// Longhorn 0.1.0 is published: three TypeScript packages on npm and the Rust
// crates by git tag. Nucleus consumes exactly those identities; the private
// sibling checkout is no longer a dependency or a proof source.
const longhornVersion = "0.1.0";
const longhornGitTag = "v0.1.0";
const longhornGitRepository = "ssh://git@github.com/inflatable-cookie/longhorn.git";
const POODLE_CORE = "@inflatable-cookie/poodle-core";
const POODLE_SVELTE = "@inflatable-cookie/poodle-svelte";

const rendererPackages = {
  "@inflatable-cookie/longhorn": "longhorn",
  "@inflatable-cookie/longhorn-poodle-svelte": "longhorn-poodle-svelte",
  "@inflatable-cookie/longhorn-tauri": "longhorn-tauri",
} as const;

const rustCrates = [
  "longhorn-bridge",
  "longhorn-command",
  "longhorn-command-config",
  "longhorn-command-settings",
  "longhorn-config",
  "longhorn-core",
  "longhorn-display",
  // Longhorn Card 179 absorbed layout into surfaces; Nucleus follows that graph.
  "longhorn-surfaces",
  "longhorn-surfaces-config",
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

// Card 164 collapsed Longhorn's eighteen renderer packages into three, so
// "nucleus does not install Surfaces" is no longer expressible or true: the
// domains ship in one package whether or not they are composed. The half of
// the claim that still holds — and is the one that ever mattered — is that
// nucleus never *imports* them. Tree-shaking keeps them out of the bundle.
// The Rust side keeps install-absence below, where the split is still real.
const forbiddenRendererImports = [
  "@inflatable-cookie/longhorn/history",
  "@inflatable-cookie/longhorn/history-tree",
  "@inflatable-cookie/longhorn/surface-transfer",
  "@inflatable-cookie/longhorn/surfaces",
  "@inflatable-cookie/longhorn-poodle-svelte/surfaces",
  "@inflatable-cookie/longhorn-poodle-svelte/surface-transfer",
] as const;
const forbiddenRustCrates = [
  "longhorn-history",
  "longhorn-surface-transfer",
  "longhorn-surface-windowing",
  // longhorn-surfaces is admitted after Card 179; transfer/windowing stay optional.
] as const;

const manifest = JSON.parse(
  readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
) as PackageManifest;

for (const name of Object.keys(rendererPackages)) {
  const pin = manifest.dependencies?.[name];
  assert(
    pin === longhornVersion,
    `${name} must pin published ${longhornVersion}, got ${pin ?? "nothing"}`,
  );
  assert(
    manifest.overrides?.[name] === undefined,
    `${name} must not carry a registry override`,
  );
}
assert(
  !manifest.overrides ||
    Object.keys(manifest.overrides).every((key) => !key.includes("longhorn")),
  "overrides must not repoint Longhorn",
);

const rendererSource = command(desktopRoot, [
  "git",
  "grep",
  "-h",
  "-o",
  "-E",
  "@inflatable-cookie/longhorn[a-z/-]*",
  "--",
  "src",
]);
for (const name of forbiddenRendererImports) {
  assert(!rendererSource.includes(name), `forbidden renderer import ${name}`);
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
  const identities = new Set(
    cargoTree
      .split("\n")
      .filter((line) => line.startsWith(`${name} `))
      // cargo tree marks deduplicated repeats with a trailing (*).
      .map((line) =>
        line
          .replace(/(?: \(\*\))+$/, "")
          .split(" ")
          .slice(1)
          .join(" "),
      ),
  );
  assert(identities.size === 1, `${name} resolved ${identities.size} identities`);
  const identity = [...identities][0]!;
  const version = identity.split(" ")[0]?.replace(/^v/, "");
  assert(
    version === longhornVersion,
    `${name} resolved ${version}, expected ${longhornVersion}`,
  );
  // The version alone cannot prove the published identity: a path checkout
  // at the same version would match. Cargo tree prints the resolved source,
  // so require the exact git tag before recording the crate.
  const expectedSource = `(${longhornGitRepository}?tag=${longhornGitTag}#`;
  assert(
    identity.includes(expectedSource),
    `${name} resolved from ${identity}, expected git tag ${longhornGitTag} of ${longhornGitRepository}`,
  );
  return { name, version, source: `git-tag ${longhornGitTag}` };
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
    "apps/desktop/src-tauri/src/config_operations/restore/tests.rs",
    "scheduled_group_restores_all_seven_domains_before_authorities_open",
  ],
  [
    "apps/desktop/src-tauri/src/config_operations/backup_domains/tests.rs",
    "grouped_absent_targets_delete_file_and_sqlite_at_boot",
  ],
  [
    "apps/desktop/src-tauri/src/config_operations/backup_domains/tests.rs",
    "boot_catalog_rolls_an_applied_domain_back_to_absence_after_interruption",
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
        release: longhornVersion,
        registry: "npm",
        rustTag: longhornGitTag,
        rustRepository: longhornGitRepository,
      },
      renderer: {
        ...rendererArtifactProof,
        forbiddenImportsAbsent: forbiddenRendererImports,
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
        backup: "config_operations::{authority,backup_domains,export,restore}",
        localBridge: "bridge",
      },
      productAuthority: {
        owner: "Nucleus",
        contract: "docs/contracts/032-longhorn-desktop-systems-integration-contract.md",
        nextEdge:
          "operator product checkpoint and next-lane selection",
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
    const consumer = resolve(temporaryRoot, "consumer");
    mkdirSync(consumer);

    const longhornIdentities = Object.keys(rendererPackages).map((name) => ({
      name,
      version: longhornVersion,
      source: "npm-registry",
    }));

    // The published Longhorn 0.1.0 release pins Poodle through the adapter's
    // peer requirement. Prove Nucleus pins a published registry release; the
    // installed-adapter peer check below closes the loop after install.
    const nucleusCorePin = manifest.dependencies?.[POODLE_CORE];
    const nucleusSveltePin = manifest.dependencies?.[POODLE_SVELTE];
    assert(
      Boolean(nucleusCorePin) && !nucleusCorePin!.startsWith("file:") && !nucleusCorePin!.startsWith("link:"),
      "Nucleus must pin published Poodle core, not a path preview",
    );
    assert(
      Boolean(nucleusSveltePin) && !nucleusSveltePin!.startsWith("file:") && !nucleusSveltePin!.startsWith("link:"),
      "Nucleus must pin published Poodle Svelte, not a path preview",
    );

    const poodleArtifacts = {
      [POODLE_CORE]: nucleusCorePin!,
      [POODLE_SVELTE]: nucleusSveltePin!,
    };

    const dependencies = {
      ...Object.fromEntries(
        Object.keys(rendererPackages).map((name) => [name, longhornVersion]),
      ),
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
    const poodleRuntime = packageManifests.filter(({ name }) => name === "@inflatable-cookie/poodle-svelte");
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
      const installedVersion = (
        JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest
      ).version;
      assert(
        installedVersion === longhornVersion,
        `${name} installed ${installedVersion}, expected ${longhornVersion}`,
      );
    }
    // Subpath absence is not checkable in a consolidated package, so assert
    // the stronger property instead: exactly the three Longhorn packages are
    // installed and no fourth one leaked in.
    const scopeRoot = resolve(consumer, "node_modules/@inflatable-cookie");
    const installedLonghorn = readdirSync(scopeRoot)
      .filter((entry) => entry === "longhorn" || entry.startsWith("longhorn-"))
      .sort();
    assert(
      JSON.stringify(installedLonghorn) ===
        JSON.stringify(
          Object.values(rendererPackages).slice().sort(),
        ),
      `artifact graph installs ${installedLonghorn.join(", ")}`,
    );

    // The adapter's exact peers are what the old overrides entry existed to
    // satisfy; prove the installed release still accepts both Poodle pins.
    const adapterPackageJson = resolve(
      consumer,
      "node_modules/@inflatable-cookie/longhorn-poodle-svelte/package.json",
    );
    assert(existsSync(adapterPackageJson), "longhorn-poodle-svelte package is not installed");
    const adapterPeers = (
      JSON.parse(readFileSync(adapterPackageJson, "utf8")) as PackageManifest & {
        peerDependencies?: Record<string, string>;
      }
    ).peerDependencies;
    assert(
      adapterPeers?.[POODLE_SVELTE] === nucleusSveltePin,
      `longhorn-poodle-svelte peer ${adapterPeers?.[POODLE_SVELTE]} diverges from Nucleus pin ${nucleusSveltePin}`,
    );
    assert(
      adapterPeers?.[POODLE_CORE] === nucleusCorePin,
      `longhorn-poodle-svelte ${POODLE_CORE} peer ${adapterPeers?.[POODLE_CORE]} diverges from Nucleus pin ${nucleusCorePin}`,
    );

    const installedPoodle = [
      { name: POODLE_CORE, expected: nucleusCorePin! },
      { name: POODLE_SVELTE, expected: nucleusSveltePin! },
    ].map(({ name, expected }) => {
      const packageJson = resolve(consumer, "node_modules", ...name.split("/"), "package.json");
      assert(existsSync(packageJson), `${name} registry package is not installed`);
      const version = (JSON.parse(readFileSync(packageJson, "utf8")) as PackageManifest).version;
      assert(version === expected, `${name} installed ${version}, expected ${expected}`);
      return { name, version: version! };
    });

    return {
      packages: longhornIdentities,
      poodleRelease: {
        version: nucleusCorePin,
        packages: installedPoodle,
        source: "npm-registry",
      },
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
