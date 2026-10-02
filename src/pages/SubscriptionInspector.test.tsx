// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import type { RuleMatch, Subscription, SubscriptionEvent } from "../types";
import { SubscriptionInspector } from "./SubscriptionInspector";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); document.body.innerHTML = ""; });

const subscription = (overrides: Partial<Subscription>): Subscription => ({ id: "1", collectionId: "inbox", type: "direct", label: "New title", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"],
  enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z", ...overrides });
async function open(details: { subscription: Subscription; events: SubscriptionEvent[]; matches: RuleMatch[] }) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api).mockResolvedValue(details);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DialogProvider><SubscriptionInspector id="1" collections={[{ id: "inbox", name: "Inbox", subscriptionCount: 1, unreadCount: 0, activityCount: 0 }]} onClose={vi.fn()} onChanged={async () => undefined} notify={vi.fn()} /></DialogProvider>));
  return { root, drawer: document.querySelector<HTMLElement>(".drawer")! };
}
const event = (id: string, kind: string, summary: string, payload: Record<string, unknown> | null): SubscriptionEvent => ({ id, kind, summary, payload, createdAt: new Date(Date.now() - 3_600_000).toISOString(), readAt: null });

it("shows what changed in direct events, with old and new titles and links, and falls back for older events", async () => {
  const snapshot = (title: string, magnet: string, torrentUrl: string) => ({ title, url: "https://rutor.info/torrent/1", magnet, torrentUrl, coverUrl: `https://img/${title}.jpg`, metadata: { size: title } });
  const { root, drawer } = await open({ subscription: subscription({}), matches: [], events: [
    event("full", "direct-change", "title changed, cover changed, magnet changed, torrent file changed", { previous: snapshot("Old title", "magnet:?old", "https://rutor.info/old.torrent"), current: snapshot("New title", "magnet:?new", "https://rutor.info/new.torrent"), changes: ["title changed", "cover changed", "magnet changed", "torrent file changed"] }),
    event("magnet-only", "direct-change", "magnet changed", { previous: { title: "Same", magnet: null }, current: { title: "Same", magnet: "magnet:?first" }, changes: ["magnet changed"] }),
    event("legacy", "direct-change", "metadata changed", { changes: ["metadata changed"] }),
    event("oldest", "direct-change", "Release changed", {}),
  ] });
  try {
    expect(api).toHaveBeenCalledWith("/api/subscriptions/1/open", expect.objectContaining({ method: "POST" }));
    const items = [...drawer.querySelectorAll(".timeline-item")];
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Title changed, cover changed, magnet changed, torrent file changed", "Magnet changed", "Metadata changed", "Release changed"]);
    const title = items[0].querySelector(".change-title")!;
    expect(title.querySelector("del")?.textContent).toBe("Previous title: Old title");
    expect(title.querySelector("ins")?.textContent).toBe("New title: New title");
    const links = [...items[0].querySelectorAll<HTMLAnchorElement>(".change-links a")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([["Magnet", "magnet:?new"], ["Previous magnet", "magnet:?old"], ["Torrent file", "https://rutor.info/new.torrent"], ["Previous torrent file", "https://rutor.info/old.torrent"]]);
    expect(items[1].querySelector(".change-title")).toBeNull();
    expect([...items[1].querySelectorAll(".change-links a")].map((link) => link.textContent)).toEqual(["Magnet"]);
    for (const item of items.slice(2)) { expect(item.querySelector(".change-title")).toBeNull(); expect(item.querySelector(".change-links")).toBeNull(); }
    expect(items[0].querySelector("small")?.getAttribute("title")).toBeTruthy();
    await act(async () => setLanguage("ru"));
    expect(items[0].querySelector("strong")?.textContent).toBe("Изменено название, изменена обложка, изменена magnet-ссылка, изменён торрент-файл");
    expect(items[0].querySelector(".change-links__previous")?.textContent).toBe("Прежняя magnet-ссылка");
  } finally { await act(async () => root.unmount()); }
});

it("lists matched releases and offers magnet and torrent actions on rule matches without nesting links", async () => {
  const releases = Array.from({ length: 7 }, (_, index) => ({ title: `Dune release ${index + 1}` }));
  const { root, drawer } = await open({ subscription: subscription({ type: "rule", label: "Dune", requiredTerms: ["Dune"], trackerKeys: ["rutracker", "kinozal"] }), events: [
    event("many", "rule-match", "New match", { releases }),
    event("one", "rule-match", "New match: Dune 2160p", { releases: [{ title: "Dune 2160p" }] }),
  ], matches: [
    { id: "m1", trackerKey: "rutracker", externalId: "1", title: "Dune 2160p", url: "https://rutracker.org/forum/viewtopic.php?t=1", magnet: "magnet:?dune", torrentUrl: "https://rutracker.org/dl.php?t=1", discoveredAt: new Date().toISOString() },
    { id: "m2", trackerKey: "kinozal", externalId: "2", title: "Dune 1080p", url: "https://kinozal.tv/details.php?id=2", magnet: null, torrentUrl: null, discoveredAt: new Date().toISOString() },
  ] });
  try {
    const [many, one] = [...drawer.querySelectorAll(".timeline-item")];
    expect(many.querySelector("strong")?.textContent).toBe("7 new matches");
    expect([...many.querySelectorAll(".change-releases li")].map((item) => item.textContent)).toEqual(["Dune release 1", "Dune release 2", "Dune release 3", "Dune release 4", "Dune release 5", "+2 more"]);
    expect(one.querySelector("strong")?.textContent).toBe("New match: Dune 2160p");
    expect(one.querySelector(".change-releases")).toBeNull();

    const [first, second] = [...drawer.querySelectorAll(".match-row")];
    expect(first.querySelector(".match-row__title")?.getAttribute("href")).toBe("https://rutracker.org/forum/viewtopic.php?t=1");
    const magnet = first.querySelector<HTMLAnchorElement>('a[aria-label="Open magnet for Dune 2160p"]')!, torrent = first.querySelector<HTMLAnchorElement>('a[aria-label="Download torrent file for Dune 2160p"]')!;
    expect(magnet.getAttribute("href")).toBe("magnet:?dune");
    expect(torrent.getAttribute("href")).toBe("https://rutracker.org/dl.php?t=1");
    expect(torrent.target).toBe("_blank");
    expect(second.querySelector(".match-row__actions")).toBeNull();
    expect(drawer.querySelectorAll(".match-list a a, .match-list a button")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
