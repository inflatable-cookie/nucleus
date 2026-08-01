import { describe, expect, test } from "bun:test";

import { browserIslandId } from "./browserPanel";

describe("browser native-content identity", () => {
  test("maps a panel to a stable island without reusing a Tauri label", () => {
    expect(browserIslandId("browser:main:1")).toBe(
      "island:nucleus-browser:browser:main:1",
    );
    expect(browserIslandId("browser panel @ 2")).toBe(
      "island:nucleus-browser:browser-panel---2",
    );
  });
});
