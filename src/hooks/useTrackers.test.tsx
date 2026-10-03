// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { TrackerTag } from "../components/UI";
import type { Tracker, TrackerKey } from "../types";
import { type TrackerList, TrackersProvider, useTrackers } from "./useTrackers";

vi.mock("../api", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
let root: Root;
let container: HTMLDivElement;
const tracker = (key: string, displayName: string): Tracker => ({ key: key as TrackerKey, displayName, hosts: [], snapshotVersion: 1,
  capabilities: { authentication: "none", customMirrors: true, direct: true, rules: true, covers: true }, baseUrl: "", globalBaseUrl: "", hasOverride: false, enabled: true, credentialsConfigured: false });
const trackerRequests = () => request.mock.calls.filter(([path]) => path === "/api/trackers").length;
let list: TrackerList;
function Names({ onError }: { onError?: (error: unknown) => void }) { list = useTrackers(onError); return <span className="names">{list.trackers?.map((item) => item.displayName).join(",") ?? "loading"}</span>; }
const render = (children: ReactNode) => act(async () => root.render(<TrackersProvider>{children}</TrackersProvider>));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); request.mockReset(); });

it("loads the tracker list once for every view in the session and reloads it on demand", async () => {
  let name = "RuTracker";
  request.mockImplementation(async () => ({ trackers: [tracker("kinozal", "Kinozal"), tracker("rutracker", name)] }));
  await render(<><Names /><Names /><TrackerTag tracker="rutracker" /></>);
  expect(trackerRequests()).toBe(1);
  expect([...container.querySelectorAll(".names")].map((item) => item.textContent)).toEqual(["Kinozal,RuTracker", "Kinozal,RuTracker"]);
  expect(container.querySelector(".tracker-tag")?.getAttribute("aria-label")).toBe("RuTracker");
  // Views mounted later reuse the loaded list.
  await render(<><Names /><Names /><Names /><TrackerTag tracker="rutracker" /></>);
  expect(trackerRequests()).toBe(1);
  name = "RuTracker mirror";
  await act(async () => { await list.reload(); });
  expect(trackerRequests()).toBe(2);
  expect(container.querySelector(".names")?.textContent).toBe("Kinozal,RuTracker mirror");
  expect(container.querySelector(".tracker-tag")?.getAttribute("aria-label")).toBe("RuTracker mirror");
});

it("reports a failed load to the views that need the list and tries again for the next one", async () => {
  request.mockRejectedValueOnce(new Error("Server unavailable")).mockResolvedValue({ trackers: [tracker("rutor", "Rutor")] });
  const onError = vi.fn();
  await render(<Names onError={onError} />);
  expect(trackerRequests()).toBe(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".names")?.textContent).toBe("loading");
  await render(<><TrackerTag tracker="rutor" /></>);
  await render(<><TrackerTag tracker="rutor" /><Names onError={onError} /></>);
  expect(trackerRequests()).toBe(2);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".names")?.textContent).toBe("Rutor");
});

it("marks a tracker without marker assets with a neutral badge and its name from the API", async () => {
  request.mockResolvedValue({ trackers: [tracker("rutor", "Rutor"), tracker("nyaa", "Nyaa")] });
  await render(<><TrackerTag tracker="rutor" /><TrackerTag tracker={"nyaa" as TrackerKey} /></>);
  const [known, unknown] = [...container.querySelectorAll(".tracker-tag")];
  expect(known.className).toBe("tracker-tag tracker-tag--icons tracker-tag--rutor");
  expect(known.querySelector("img")?.getAttribute("src")).toBe("/tracker-favicons/rutor.ico");
  expect(unknown.className).toBe("tracker-tag tracker-tag--abbreviations tracker-tag--nyaa");
  expect(unknown.querySelector("img")).toBeNull();
  expect(unknown.textContent).toBe("NY");
  expect(unknown.getAttribute("aria-label")).toBe("Nyaa");
});
