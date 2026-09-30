import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { russian } from "../src/i18n.js";

describe("UI message catalogue coverage", () => {
  it("has Russian translations for direct literal message calls", () => {
    const paths = ["src/App.tsx", "src/format.ts", ...["src/pages", "src/components"].flatMap((directory) => readdirSync(directory).filter((path) => path.endsWith(".tsx") && !path.includes(".test.")).map((path) => `${directory}/${path}`))];
    const missing = new Set<string>();
    for (const path of paths) for (const match of readFileSync(path, "utf8").matchAll(/\bt\("([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      const key = JSON.parse(`"${match[1]}"`) as string;
      if (!russian[key]) missing.add(key);
    }
    expect([...missing]).toEqual([]);
  });
});
