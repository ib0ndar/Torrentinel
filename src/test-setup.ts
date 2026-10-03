import { afterEach } from "vitest";

// jsdom keeps one Storage per test file; start every test without values stored by the previous one.
afterEach(() => {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) if (typeof storage?.clear === "function") storage.clear();
});
