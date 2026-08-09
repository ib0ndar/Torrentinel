import { describe, expect, it } from "vitest";
import { normalizeTrackerChangeMarker } from "./parsing.js";

describe("tracker change markers", () => {
  const now = new Date("2026-08-08T09:15:00Z");

  it("normalizes Russian relative and named dates into stable values", () => {
    expect(normalizeTrackerChangeMarker("сегодня в 12:34", now)).toBe("2026-08-08 12:34");
    expect(normalizeTrackerChangeMarker("вчера 23:10", now)).toBe("2026-08-07 23:10");
    expect(normalizeTrackerChangeMarker("7 августа 2026 в 12:34", now)).toBe("2026-08-07 12:34");
  });

  it("removes changing relative-age suffixes", () => {
    expect(normalizeTrackerChangeMarker("07-08-2026 10:30 (2 часа назад)", now)).toBe("2026-08-07 10:30");
    expect(normalizeTrackerChangeMarker("07-08-2026 10:30 (3 часа назад)", now)).toBe("2026-08-07 10:30");
  });
});
