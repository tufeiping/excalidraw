import { STORAGE_KEYS } from "../app_constants";

export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 900;
export const PANEL_DEFAULT_WIDTH = 400;
/** 0.5rem inset on the right plus breathing room on the left */
export const PANEL_INSET = 24;

/**
 * Clamp a width to what actually fits on screen. The panel is anchored to the
 * right edge, so on narrow viewports the upper bound shrinks below
 * `PANEL_MAX_WIDTH`.
 */
export const clampPanelWidth = (value: number, viewportWidth?: number) => {
  const viewport =
    typeof viewportWidth === "number"
      ? viewportWidth
      : typeof window === "undefined"
      ? PANEL_MAX_WIDTH + PANEL_INSET
      : window.innerWidth;
  const max = Math.max(
    PANEL_MIN_WIDTH,
    Math.min(PANEL_MAX_WIDTH, viewport - PANEL_INSET),
  );
  return Math.round(Math.min(Math.max(value, PANEL_MIN_WIDTH), max));
};

/** Width the panel should open with: the user's last drag, else the default. */
export const loadPanelWidth = () => {
  try {
    const raw = window.localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_PANEL_WIDTH,
    );
    const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(value)) {
      return clampPanelWidth(value);
    }
  } catch {
    // private mode / disabled storage: fall back to the default width
  }
  return PANEL_DEFAULT_WIDTH;
};

export const savePanelWidth = (value: number) => {
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_PANEL_WIDTH,
      String(Math.round(value)),
    );
  } catch {
    // ignore quota / privacy errors; resizing still works for this session
  }
};
