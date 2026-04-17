import { expect } from "bun:test";

const HAMBURGER_ICON_PATH = "M4 7h16M4 12h16M4 17h16";

export function expectHamburgerIcon(button: HTMLElement): void {
  const path = button.querySelector("svg path");
  if (path === null) {
    throw new Error("Expected button to contain an SVG path element");
  }
  expect(path.getAttribute("d")).toBe(HAMBURGER_ICON_PATH);
}
