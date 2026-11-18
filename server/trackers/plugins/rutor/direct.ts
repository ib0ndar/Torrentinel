import * as cheerio from "cheerio";
import { fileListSignal, fileManifest, fileSize } from "../../../torrent-files.js";
import type { DirectMonitor } from "../../core/contracts.js";
import { fingerprintRelease } from "../../core/parsing.js";
import { parseRutorDirect } from "./parser.js";
import type { RutorTransport } from "./transport.js";

export function createRutorDirectMonitor(transport: RutorTransport, normalizeUrl: (url: URL, baseUrl: string) => string): DirectMonitor {
  return {
    async fetchSnapshot(url, context, includeFiles) {
      const normalized = normalizeUrl(new URL(url), context.baseUrl);
      const result = await transport.get(normalized, context);
      const release = parseRutorDirect(result.body, normalized);
      let files;
      if (includeFiles && /^\d+$/.test(release.externalId) && /\bid=["']filelist["']/i.test(result.body)) {
        const count = /Файлы\s*\((\d+)\)/u.exec(result.body)?.[1];
        try {
          const listUrl = new URL(`/descriptions/${release.externalId}.files`, normalized);
          const list = await transport.get(listUrl.href, { ...context, signal: fileListSignal(context.signal) });
          const $ = cheerio.load(`<table>${list.body}</table>`);
          const rows = $("tr").toArray().map((row) => {
            const cells = $(row).children("td");
            return { path: cells.first().text().trim(), size: cells.length === 2 ? fileSize(cells.eq(1).text()) : undefined };
          });
          if (!count || rows.length === Number(count)) files = fileManifest(rows);
        } catch {
          context.signal?.throwIfAborted();
        }
      }
      return { ...release, fingerprint: fingerprintRelease(release), ...(files ? { files } : {}) };
    },
  };
}
