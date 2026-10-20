import { STORAGE_KEYS } from "../app_constants";

import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
} from "./panelWidth";

describe("agent panel width", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the width inside the usable range", () => {
    expect(clampPanelWidth(120, 1400)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000, 1400)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(520, 1400)).toBe(520);
  });

  it("never lets the panel be wider than the viewport", () => {
    // 24px of inset for the right margin plus breathing room
    expect(clampPanelWidth(800, 640)).toBe(616);
    expect(clampPanelWidth(PANEL_MAX_WIDTH, 520)).toBe(496);
  });

  it("round-trips the dragged width", () => {
    expect(loadPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);

    savePanelWidth(548);
    expect(loadPanelWidth()).toBe(548);

    // ...also after a reload of the page
    expect(
      window.localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_PANEL_WIDTH),
    ).toBe("548");
  });

  it("clamps a stored width that no longer fits", () => {
    window.localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_PANEL_WIDTH,
      "1200",
    );
    expect(loadPanelWidth()).toBe(PANEL_MAX_WIDTH);
  });

  it("ignores a corrupted stored width", () => {
    window.localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_PANEL_WIDTH,
      "not-a-number",
    );
    expect(loadPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });
});
