import packageManifest from "../../package.json";

export type IconName = "monitor" | "sliders" | "users" | "arrow" | "plus" | "clock" | "edit" | "trash" | "search" | "link" | "rule" | "folder" | "refresh" | "alert" | "external" | "magnet" | "download" | "send" | "close" | "bellAlert";
const SPRITE_URL = `/brand/ui/sprite.svg?v=${encodeURIComponent(packageManifest.version)}`;
const symbols: Record<IconName, string> = {
  monitor: "monitor-eye", sliders: "settings", users: "shield", arrow: "resume", plus: "add", clock: "clock",
  edit: "settings", trash: "trash", search: "search", link: "link", rule: "keyword", folder: "hexagon",
  refresh: "sync", alert: "alert", external: "tracker", magnet: "magnet", download: "download", send: "bell",
  close: "add", bellAlert: "bell-alert",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className={`icon icon--${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><use href={`${SPRITE_URL}#ti-${symbols[name]}`} /></svg>;
}
