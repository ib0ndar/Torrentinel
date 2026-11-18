import * as cheerio from "cheerio";
import { fileManifest, fileSize } from "../../../torrent-files.js";
import type { DirectMonitor } from "../../core/contracts.js";
import { fingerprintRelease } from "../../core/parsing.js";
import type { KinozalPageSession } from "./auth.js";
import { parseKinozalDirect } from "./parser.js";

export function createKinozalDirectMonitor(session: KinozalPageSession, normalizeUrl: (url: URL, baseUrl: string) => string): DirectMonitor {
  return {
    async fetchSnapshot(url, context, includeFiles) {
      const normalized = normalizeUrl(new URL(url), context.baseUrl);
      const result = await session.get(normalized, context);
      const release = parseKinozalDirect(result.body, normalized);
      let files;
      if (includeFiles && /^\d+$/.test(release.externalId) && session.getOptional) {
        const listUrl = new URL("/get_srv_details.php", normalized);
        listUrl.search = new URLSearchParams({ id: release.externalId, action: "2" }).toString();
        const list = await session.getOptional(listUrl.href, context);
        if (list) files = parseKinozalFiles(list.body);
      }
      return { ...release, fingerprint: fingerprintRelease(release), ...(files ? { files } : {}) };
    },
  };
}

function parseKinozalFiles(body: string) {
  const $ = cheerio.load(body);
  const tree = $("div.treeview").first();
  const entries = tree.length ? tree.find("li").filter((_, entry) => !$(entry).children("ul").length) : $("div.b.ing");
  const name = (element: typeof entries) => {
    const label = element.clone();
    label.find("ul, i").remove();
    return label.text().trim();
  };
  return fileManifest(entries.toArray().map((entry) => {
    const element = $(entry);
    const folders = element.parentsUntil(tree, "li").toArray().reverse().map((folder) => name($(folder)));
    const path = [...folders, name(element)];
    return { path: path.every(Boolean) ? path.join("/") : "", size: fileSize(element.find("i").first().text()) };
  }));
}
