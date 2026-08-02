import { describe, expect, test } from "vitest";

import {
  nucleusCommandContextPath,
  projectNucleusCommandAvailability,
  type NucleusCommandFacts,
} from "./runtime.svelte";

const EMPTY: NucleusCommandFacts = {
  selectedProjectId: null,
  activePanelKind: null,
  openPanelKinds: [],
  activeThread: false,
  editorDirty: false,
  agentTurnRunning: false,
};

describe("Nucleus command projection", () => {
  test("keeps global discovery available and explains missing product context", () => {
    expect(projectNucleusCommandAvailability("nucleus:shell.show-command-palette", EMPTY).state)
      .toBe("available");
    const projectCommand = projectNucleusCommandAvailability(
      "nucleus:project.rename-selected",
      EMPTY,
    );
    expect(projectCommand.state).toBe("unavailable");
    expect(projectCommand.reason?.detail).toBe("Select a project first.");
    expect(nucleusCommandContextPath(EMPTY)).toEqual(["global", "workspace"]);
  });

  test("projects the focused panel context and live command facts", () => {
    const facts: NucleusCommandFacts = {
      selectedProjectId: "project:1",
      activePanelKind: "editor",
      openPanelKinds: ["editor", "tasks"],
      activeThread: true,
      editorDirty: true,
      agentTurnRunning: true,
    };
    expect(nucleusCommandContextPath(facts)).toEqual([
      "global",
      "workspace",
      "project",
      "panel",
      "editor",
    ]);
    expect(projectNucleusCommandAvailability("nucleus:editor.save", facts).state)
      .toBe("available");
    expect(projectNucleusCommandAvailability("nucleus:agent.cancel-turn", facts).state)
      .toBe("available");
    expect(projectNucleusCommandAvailability("nucleus:panel.open-tasks", facts).reason?.detail)
      .toBe("The project already has a Tasks panel open.");
  });

  test("does not admit stale editor or agent operations", () => {
    const facts = { ...EMPTY, selectedProjectId: "project:1", activePanelKind: "editor" };
    expect(projectNucleusCommandAvailability("nucleus:editor.save", facts).state)
      .toBe("unavailable");
    expect(projectNucleusCommandAvailability("nucleus:agent.cancel-turn", facts).state)
      .toBe("unavailable");
  });
});
