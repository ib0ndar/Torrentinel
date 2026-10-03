import { describe, expect, it } from "vitest";
import { ADMIN_TABS, adminPath, DEFAULT_DIAGNOSTICS_VIEW, parseRoute } from "./routing";

const diagnostics = (path: string, search: string) => { const route = parseRoute(path, search); return route.name === "admin" ? route.diagnostics : undefined; };

describe("Administration routes", () => {
  it("parses each section and treats /admin and unknown sections as unresolved Overview", () => {
    for (const tab of ADMIN_TABS) expect(parseRoute(`/admin/${tab}`, "")).toEqual({ name: "admin", tab, explicit: true, diagnostics: DEFAULT_DIAGNOSTICS_VIEW });
    for (const path of ["/admin", "/admin/", "/admin/unknown", "/admin/users/extra"]) expect(parseRoute(path, "")).toEqual({ name: "admin", tab: "overview", explicit: false, diagnostics: DEFAULT_DIAGNOSTICS_VIEW });
    expect(parseRoute("/admin/users/", "")).toMatchObject({ tab: "users", explicit: true });
    expect(parseRoute("/administration", "")).toMatchObject({ name: "monitor", explicit: false });
  });

  it("reads Diagnostics filters and pages from the query and drops invalid values", () => {
    expect(parseRoute("/admin/diagnostics", "?tracker=rutor&outcome=temporarily-unavailable&page=3&deliveriesPage=2")).toMatchObject({
      tab: "diagnostics", diagnostics: { tracker: "rutor", outcome: "temporarily-unavailable", page: 3, deliveriesPage: 2 } });
    expect(diagnostics("/admin/diagnostics", "?tracker=bogus&outcome=%3Cscript%3E&page=0&deliveriesPage=1.5")).toEqual(DEFAULT_DIAGNOSTICS_VIEW);
    expect(diagnostics("/admin/diagnostics", `?outcome=${"x".repeat(41)}&page=99999999`)).toEqual(DEFAULT_DIAGNOSTICS_VIEW);
    // Only Diagnostics keeps query state.
    expect(diagnostics("/admin/users", "?page=4&tracker=rutor")).toEqual(DEFAULT_DIAGNOSTICS_VIEW);
  });

  it("formats canonical addresses with defaults omitted and round-trips them", () => {
    expect(adminPath("overview")).toBe("/admin/overview");
    expect(adminPath("users", { tracker: "rutor", outcome: "error", page: 2, deliveriesPage: 2 })).toBe("/admin/users");
    expect(adminPath("diagnostics")).toBe("/admin/diagnostics");
    expect(adminPath("diagnostics", { ...DEFAULT_DIAGNOSTICS_VIEW, page: 1, deliveriesPage: 1 })).toBe("/admin/diagnostics");
    const view = { tracker: "kinozal", outcome: "new-matches", page: 2, deliveriesPage: 4 } as const;
    const path = adminPath("diagnostics", view);
    expect(path).toBe("/admin/diagnostics?tracker=kinozal&outcome=new-matches&page=2&deliveriesPage=4");
    const url = new URL(path, "http://test");
    expect(parseRoute(url.pathname, url.search)).toEqual({ name: "admin", tab: "diagnostics", explicit: true, diagnostics: view });
  });

  it("keeps parsing Monitor pages as before", () => {
    expect(parseRoute("/collections/films", "?page=2")).toMatchObject({ name: "monitor", explicit: true, view: { collectionId: "films", page: 2 } });
    expect(parseRoute("/collections/films", "?page=0")).toMatchObject({ view: { page: 1 } });
  });
});
