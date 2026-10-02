import packageManifest from "../../package.json";

export type IconName = "monitor" | "sliders" | "users" | "plus" | "clock" | "edit" | "trash" | "search" | "link" | "rule" | "folder" | "refresh" | "alert" | "external" | "magnet" | "download" | "send" | "close" | "check" | "logout" | "more" | "user" | "chevron" | "activity" | "sort";
const SPRITE_URL = `/brand/ui/sprite.svg?v=${encodeURIComponent(packageManifest.version)}`;
const symbols: Record<IconName, string> = {
  monitor: "monitor-eye", sliders: "settings", users: "shield", plus: "add", clock: "clock",
  edit: "edit", trash: "trash", search: "search", link: "link", rule: "keyword", folder: "hexagon",
  refresh: "sync", alert: "alert", external: "external", magnet: "magnet", download: "download", send: "bell",
  close: "add", check: "check", logout: "logout", more: "more", user: "user", chevron: "chevron-down", activity: "pulse", sort: "sort",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className={`icon icon--${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><use href={`${SPRITE_URL}#ti-${symbols[name]}`} /></svg>;
}
