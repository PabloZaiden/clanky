/**
 * Frontend test setup for the happy-dom environment.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { afterEach } from "bun:test";

GlobalRegistrator.register();

// Relative app requests and test URL assertions need a real document origin.
if (window.location.href === "about:blank") {
  window.location.href = "http://localhost:3000/";
}

afterEach(() => {
  cleanup();
});
