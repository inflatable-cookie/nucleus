import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { hostList } from "../shared/rpc/hosts";
import type { CapacityAuthorityValues } from "../shared/contracts";

useNativeStubs();
const h = React.createElement;
const hosts = () => import("../client/hosts-settings");

const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
  statusSuccess: "#3fb950",
} as const;
const c = dark as never;
const CAPACITY: CapacityAuthorityValues = {
  globalLimit: 32,
  projectLimit: 5,
  hostCallLimit: 6,
  operatorDefaultHostKind: "paseo",
  threadRetentionDays: 3,
  threadRetentionIntervalHours: 12,
};
const BB = "bb:0123456789abcdef";
const now = Date.parse("2026-11-18T12:00:00.000Z");

/**
 * A `host.list` answer as the service builds it from the stored catalogue
 * (`{id, endpoint}`) and the health projection, parsed through the wire contract
 * so the fixture cannot drift from the real shape. IDs are synthetic.
 */
const LIST = hostList.output.parse({
  defaultHostKind: "paseo",
  removals: [],
  hosts: [
    {
      id: "paseo-primary",
      kind: "paseo",
      label: "Paseo",
      endpoint: "ws://127.0.0.1:6767/ws",
      state: "online",
      reason: "",
      isDefault: true,
      connectedAt: "2026-11-18T09:00:00.000Z",
      lastSeenAt: "2026-11-18T09:00:00.000Z",
      versions: [],
      dependents: [{ kind: "task", label: "live task", names: ["acme#12"] }],
      removalBlockers: ["Host is online", "1 live task (acme#12)"],
    },
    {
      id: BB,
      kind: "bb",
      label: "BB",
      endpoint: "bb-data-dir:/synthetic/bb",
      state: "offline",
      reason:
        "sdkVersion: the plugin build does not match; run nucleus bb install",
      isDefault: false,
      lastSeenAt: "2026-11-17T08:00:00.000Z",
      versions: [
        { label: "BB", value: "0.49.0" },
        { label: "SDK", value: "0.6.132" },
      ],
      heartbeat: { at: "2026-11-18T11:59:30.000Z", stale: false },
      dependents: [
        { kind: "repository", label: "repository", names: ["acme/widgets"] },
      ],
      removalBlockers: [],
    },
    {
      id: "t3code:env-retired",
      kind: "t3code",
      label: "T3Code",
      endpoint: "ws://127.0.0.1:3773/ws",
      state: "offline",
      reason: "Host is offline",
      isDefault: false,
      versions: [],
      dependents: [
        {
          kind: "effect",
          label: "unsettled effect",
          names: ["process cleanup for acme#9"],
        },
      ],
      removalBlockers: ["1 unsettled effect (process cleanup for acme#9)"],
    },
  ],
});

async function mountHosts(
  overrides: Record<string, unknown> = {},
  rust = false,
) {
  const { HostsPanel } = await hosts();
  const removed: string[] = [];
  const invoke = async () => ({});
  const renderPanel = (props: Record<string, unknown>) =>
    h(HostsPanel as never, props as never);
  const props: Record<string, unknown> = {
    c,
    list: LIST,
    loading: false,
    loadError: null,
    retry: () => {},
    defaultValues: CAPACITY,
    saveDefaultHost: async () => {},
    remove: async (hostId: string) => {
      removed.push(hostId);
    },
    ...overrides,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () =>
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h((props) => props.children, {
          children: renderPanel(props),
        }),
      }),
    });
  const ui = mount(tree());
  return {
    ui,
    removed,
    update: (next: Record<string, unknown>) => {
      Object.assign(props, next);
      ui.update(tree());
    },
    done: () => {
      ui.update(h("View", null));
      client.clear();
    },
  };
}

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("the hosts panel did not settle");
}

test("every catalogue host is one row with its status, the default mark and an offline host's reason", async () => {
  const { ui, done } = await mountHosts();
  try {
    assert.ok(ui.get("Paseo host paseo-primary, Online, default"));
    assert.ok(ui.get(`BB host ${BB}, Offline`));
    assert.ok(ui.get("T3Code host t3code:env-retired, Offline"));
    assert.equal(
      ui.all("Default host").length,
      1,
      "one Default mark, on the host the default resolves to",
    );
    assert.match(
      ui.get(`${BB} offline reason`).children.join(""),
      /run nucleus bb install/,
    );
    assert.match(
      ui.get("t3code:env-retired offline reason").children.join(""),
      /Host is offline/,
    );
    assert.equal(
      ui.query("paseo-primary offline reason"),
      undefined,
      "an online host shows no reason",
    );
    assert.doesNotMatch(
      ui.text(),
      /bb-data-dir/,
      "details stay closed until asked for",
    );
  } finally {
    done();
  }
});

test("details show only what the host reports: ID, endpoint, times, versions, heartbeat and dependents", async () => {
  const { ui, done } = await mountHosts();
  try {
    ui.press(`Show details for ${BB}`);
    const text = ui.text();
    assert.match(text, /bb-data-dir:\/synthetic\/bb/);
    assert.match(text, /Last seen/);
    assert.match(text, /0\.49\.0/);
    assert.match(text, /0\.6\.132/);
    assert.match(text, /Heartbeat/);
    assert.match(text, /1 repository/);
    assert.match(text, /acme\/widgets/);
    ui.press("Show details for t3code:env-retired");
    assert.doesNotMatch(
      ui.text(),
      /T3Code\s*\d/,
      "a host that reported no version shows none",
    );
    ui.press("Show details for paseo-primary");
    assert.match(ui.text(), /Connected/);
  } finally {
    done();
  }
});

test("Remove names every reason it refuses, and confirms before forgetting an unused offline host", async () => {
  const { ui, removed, done } = await mountHosts();
  try {
    ui.press("Show details for t3code:env-retired");
    ui.press("Remove t3code:env-retired");
    assert.ok(ui.get("t3code:env-retired cannot be removed"));
    assert.match(
      ui.text(),
      /1 unsettled effect \(process cleanup for acme#9\)/,
    );
    assert.equal(
      ui.query("Remove host t3code:env-retired"),
      undefined,
      "a refused removal offers no confirm",
    );

    ui.press("Show details for paseo-primary");
    ui.press("Remove paseo-primary");
    assert.match(ui.text(), /Host is online/);

    ui.press(`Show details for ${BB}`);
    ui.press(`Remove ${BB}`);
    assert.ok(
      ui.get(`Remove ${BB} help`),
      "the confirm carries the re-registration note behind (?)",
    );
    ui.press(`Remove host ${BB}`);
    await settle(() => removed.length === 1);
    assert.deepEqual(removed, [BB]);
  } finally {
    done();
  }
});

test("a refused write shows the service's reason beside the confirm", async () => {
  const { ui, done } = await mountHosts({
    remove: async () => {
      throw new Error(
        "Host bb:0123456789abcdef cannot be removed: Host is online",
      );
    },
  });
  try {
    ui.press(`Show details for ${BB}`);
    ui.press(`Remove ${BB}`);
    ui.press(`Remove host ${BB}`);
    await settle(() => /cannot be removed: Host is online/.test(ui.text()));
  } finally {
    done();
  }
});

test("the default host picker lives here and saves through the Settings capacity write", async () => {
  let saved: CapacityAuthorityValues["operatorDefaultHostKind"] | undefined;
  const { ui, done } = await mountHosts({
    saveDefaultHost: async (
      host: CapacityAuthorityValues["operatorDefaultHostKind"],
    ) => {
      saved = host;
    },
  });
  try {
    ui.press("Default host, Paseo");
    ui.press("Default host: BB");
    await settle(() => saved === "bb");
    assert.equal(saved, "bb");
  } finally {
    done();
  }
});

test("Rust default host stays hidden until a second host is registered", async () => {
  const oneHost = { ...LIST, hosts: [LIST.hosts[2]!] };
  const single = await mountHosts(
    {
      list: oneHost,
      defaultValues: { ...CAPACITY, operatorDefaultHostKind: "t3code" },
    },
    true,
  );
  try {
    assert.equal(single.ui.query("Default host, T3Code"), undefined);
    assert.doesNotMatch(single.ui.text(), /Default host/);
    assert.doesNotMatch(single.ui.text(), /Paseo|BB/);
  } finally {
    single.done();
  }

  // The Rust Hosts domain currently models T3; this fixture covers a later ADE.
  const withSecondHost = {
    ...LIST,
    hosts: [LIST.hosts[2]!, LIST.hosts[1]!],
  };
  const multiple = await mountHosts(
    {
      list: withSecondHost,
      defaultValues: { ...CAPACITY, operatorDefaultHostKind: "t3code" },
    },
    true,
  );
  try {
    multiple.ui.press("Default host, T3Code");
    assert.deepEqual(
      multiple.ui
        .all(/^Default host: /)
        .map(({ props }) => props.accessibilityLabel)
        .sort(),
      ["Default host: BB", "Default host: Planner's host", "Default host: T3Code"],
    );
    assert.match(multiple.ui.text(), /T3Code/);
    assert.match(multiple.ui.text(), /BB/);
    assert.match(multiple.ui.text(), /Planner's host/);
    assert.doesNotMatch(multiple.ui.text(), /Paseo/);
  } finally {
    multiple.done();
  }
});

test("a single Rust host hides an unregistered default without saving", async () => {
  let saves = 0;
  const onlyT3 = { ...LIST, hosts: [LIST.hosts[2]!] };
  const unavailable = await mountHosts(
    {
      list: onlyT3,
      defaultValues: { ...CAPACITY, operatorDefaultHostKind: "bb" },
      saveDefaultHost: async () => {
        saves++;
      },
    },
    true,
  );
  try {
    assert.equal(unavailable.ui.query("Default host, Unavailable"), undefined);
    assert.doesNotMatch(unavailable.ui.text(), /Paseo|BB/);
    assert.equal(saves, 0);
  } finally {
    unavailable.done();
  }
});

test("a pending or failed Rust host read keeps the default picker hidden", async () => {
  for (const loadError of [null, new Error("service unavailable")]) {
    const unknown = await mountHosts(
      {
        list: undefined,
        loadError,
        defaultValues: { ...CAPACITY, operatorDefaultHostKind: "bb" },
      },
      true,
    );
    try {
      assert.equal(unknown.ui.query("Default host, BB"), undefined);
      assert.doesNotMatch(unknown.ui.text(), /Default host/);
    } finally {
      unknown.done();
    }
  }
});

test("an empty catalogue and a failed read each say so", async () => {
  const empty = await mountHosts({ list: { ...LIST, hosts: [] } });
  try {
    assert.match(empty.ui.text(), /None yet/);
  } finally {
    empty.done();
  }
  let retried = 0;
  const failed = await mountHosts({
    list: undefined,
    loadError: new Error("service unavailable"),
    retry: () => {
      retried++;
    },
  });
  try {
    assert.match(
      failed.ui.text(),
      /Couldn't read the hosts: service unavailable/,
    );
    failed.ui.press("Retry reading the hosts");
    assert.equal(retried, 1);
  } finally {
    failed.done();
  }
});

/** The names a dependents row renders, in order, from its selectable value text. */
function renderedNames(
  ui: { ofType(type: string): HostNode[] },
  marker: string,
): string[] {
  const text = (node: HostNode | string): string =>
    typeof node === "string" ? node : node.children.map(text).join("");
  const values = ui
    .ofType("Text")
    .filter((node) => node.props.selectable)
    .map(text)
    .filter((value) => value.includes(marker));
  assert.equal(values.length, 1, `one dependents row names ${marker}`);
  const names = values[0].split("\n").at(-1)!;
  return names.replace(/, …$/, "").split(", ");
}

test("a long dependents row shows its count, eight names and Show all; a short row lists every name", async () => {
  // 465 unsettled effects, worded as `hostDependents` words them (synthetic task references).
  const effects = [
    ...Array.from(
      { length: 417 },
      (_, i) => `thread cleanup for acme#${i + 1}`,
    ),
    ...Array.from(
      { length: 40 },
      (_, i) => `process cleanup for acme#${i + 500}`,
    ),
    ...Array.from({ length: 8 }, (_, i) => `dispatch for acme#${i + 600}`),
  ];
  // Repository paths can contain " for "; they are never grouped as effect kinds.
  const repositories = Array.from(
    { length: 9 },
    (_, i) => `/workspace/Work for clients/repo-${i + 1}`,
  );
  const host = (id: string, names: string[], repos: string[] = []) => ({
    id,
    kind: "t3code",
    label: "T3Code",
    endpoint: "ws://127.0.0.1:3773/ws",
    state: "offline",
    reason: "Host is offline",
    isDefault: false,
    versions: [],
    dependents: [
      { kind: "effect", label: "unsettled effect", names },
      ...(repos.length
        ? [{ kind: "repository", label: "repository", names: repos }]
        : []),
    ],
    removalBlockers: [],
  });
  const list = hostList.output.parse({
    defaultHostKind: "paseo",
    removals: [],
    hosts: [
      host("t3code:long", effects, repositories),
      host("t3code:short", effects.slice(0, 3)),
    ],
  });
  const { ui, done } = await mountHosts({ list });
  try {
    ui.press("Show details for t3code:long");
    const text = ui.text();
    assert.match(text, /465 unsettled effects/);
    assert.match(
      text,
      /thread cleanup ×417 · process cleanup ×40 · dispatch ×8/,
      "repeated effect kinds group with their counts",
    );
    assert.deepEqual(
      renderedNames(ui, "cleanup for acme#"),
      effects.slice(0, 8),
      "the collapsed row shows exactly the first eight names",
    );
    assert.match(text, /9 repositories/);
    assert.doesNotMatch(text, /×9/, "repository paths never group");
    assert.deepEqual(renderedNames(ui, "repo-"), repositories.slice(0, 8));
    ui.press("Show all 465 unsettled effects on t3code:long");
    assert.deepEqual(
      renderedNames(ui, "cleanup for acme#"),
      effects,
      "the expanded row shows every name in order",
    );
    ui.press("Show fewer 465 unsettled effects on t3code:long");
    assert.deepEqual(
      renderedNames(ui, "cleanup for acme#"),
      effects.slice(0, 8),
    );
    ui.press("Hide details for t3code:long");

    ui.press("Show details for t3code:short");
    assert.match(ui.text(), /3 unsettled effects/);
    assert.deepEqual(
      renderedNames(ui, "cleanup for acme#"),
      effects.slice(0, 3),
      "a short row lists every name as before",
    );
    assert.equal(
      ui.query("Show all 3 unsettled effects on t3code:short"),
      undefined,
      "a short row has no Show all",
    );
    assert.doesNotMatch(ui.text(), /×/, "a short row has no group summary");
  } finally {
    done();
  }
});

/** A catalogue entry for the grouping tests: only the row-relevant fields vary. */
function groupingHost(entry: {
  id: string;
  kind: "paseo" | "t3code" | "bb";
  label: string;
  state: "online" | "offline" | "unknown" | "conflict";
  reason: string;
  isDefault?: boolean;
}) {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    endpoint: "ws://127.0.0.1:6767/ws",
    state: entry.state,
    reason: entry.reason,
    isDefault: entry.isDefault ?? false,
    versions: [],
    dependents: [],
    removalBlockers: [],
  };
}

const MIXED = [
  groupingHost({
    id: "t3code:retired",
    kind: "t3code",
    label: "T3Code",
    state: "offline",
    reason: "Host is offline",
  }),
  groupingHost({
    id: "bb:conflicted",
    kind: "bb",
    label: "BB",
    state: "conflict",
    reason: "Identity conflict: two data directories claim this host",
  }),
  groupingHost({
    id: "paseo-primary",
    kind: "paseo",
    label: "Paseo",
    state: "online",
    reason: "",
    isDefault: true,
  }),
  groupingHost({
    id: "t3code:mystery",
    kind: "t3code",
    label: "T3Code",
    state: "unknown",
    reason: "Never seen",
  }),
  groupingHost({
    id: "t3code:second-online",
    kind: "t3code",
    label: "T3Code",
    state: "online",
    reason: "",
  }),
];

test("online hosts render first with one divider; Offline, Unknown and Identity conflict keep their labels", async () => {
  const list = hostList.output.parse({
    defaultHostKind: "paseo",
    removals: [],
    hosts: MIXED,
  });
  const { ui, done } = await mountHosts({ list });
  try {
    const text = ui.text();
    const onlineFirst = text.indexOf("paseo-primary");
    const onlineSecond = text.indexOf("t3code:second-online");
    const offline = text.indexOf("t3code:retired");
    const conflict = text.indexOf("bb:conflicted");
    const unknown = text.indexOf("t3code:mystery");
    for (const at of [onlineFirst, onlineSecond, offline, conflict, unknown])
      assert.ok(at >= 0, "every catalogue host renders");
    assert.ok(
      onlineFirst < onlineSecond &&
        onlineSecond < offline &&
        offline < conflict &&
        conflict < unknown,
      "online hosts first in catalogue order, then the rest in catalogue order",
    );
    assert.equal(
      ui.all("Offline hosts").length,
      1,
      "one divider between the groups",
    );
    assert.match(text, /Offline/);
    assert.match(text, /Identity conflict/);
    assert.match(text, /Unknown/);
    assert.match(text, /Host is offline/);
    assert.match(text, /two data directories claim this host/);
    assert.match(text, /Never seen/);
    assert.equal(
      ui.all("Default host").length,
      1,
      "the default mark stays on its host across the grouping",
    );
  } finally {
    done();
  }
});

test("a single group renders with no divider", async () => {
  const onlineOnly = hostList.output.parse({
    defaultHostKind: "paseo",
    removals: [],
    hosts: MIXED.filter((host) => host.state === "online"),
  });
  const onlyOnline = await mountHosts({ list: onlineOnly });
  try {
    assert.equal(
      onlyOnline.ui.query("Offline hosts"),
      undefined,
      "no divider above an online-only list",
    );
  } finally {
    onlyOnline.done();
  }
  const offlineOnly = hostList.output.parse({
    defaultHostKind: "paseo",
    removals: [],
    hosts: MIXED.filter((host) => host.state !== "online"),
  });
  const onlyOffline = await mountHosts({ list: offlineOnly });
  try {
    assert.equal(
      onlyOffline.ui.query("Offline hosts"),
      undefined,
      "no divider above an offline-only list",
    );
  } finally {
    onlyOffline.done();
  }
});

test("an updated status moves the host across the divider without losing its expanded details", async () => {
  const list = hostList.output.parse({
    defaultHostKind: "paseo",
    removals: [],
    hosts: MIXED,
  });
  const { ui, update, done } = await mountHosts({ list });
  try {
    ui.press("Show details for t3code:retired");
    assert.match(ui.text(), /ws:\/\/127\.0\.0\.1:6767\/ws/);
    assert.ok(
      ui.text().indexOf("paseo-primary") <
        ui.text().indexOf("t3code:retired"),
      "the offline host starts below the online host",
    );
    update({
      list: hostList.output.parse({
        defaultHostKind: "paseo",
        removals: [],
        hosts: MIXED.map((host) =>
          host.id === "t3code:retired"
            ? { ...host, state: "online" as const, reason: "" }
            : host,
        ),
      }),
    });
    const text = ui.text();
    assert.ok(
      text.indexOf("t3code:retired") < text.indexOf("paseo-primary"),
      "the reconnected host joins the online group in catalogue order",
    );
    assert.match(
      text,
      /ws:\/\/127\.0\.0\.1:6767\/ws/,
      "its expanded details stay open across the move",
    );
  } finally {
    done();
  }
});
