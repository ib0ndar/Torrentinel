import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, nowIso, type SqliteDatabase } from "./db.js";
import { createSecretVault, telegramTokenAad, type SecretVault } from "./secrets.js";
import { TelegramService } from "./telegram.js";

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("rich Telegram release notifications", () => {
  it("sends artwork, release details, and only tracker and magnet buttons", async () => {
    const calls: TelegramCall[] = [];
    const { db, vault, userId } = notificationDatabase();
    const telegram = new TelegramService(db, vault, telegramFetcher(calls), "https://torrentinel.example");
    const hash = "a".repeat(40);

    await telegram.notifyRelease(userId, {
      trackerName: "RuTracker",
      ruleTerms: ["The <Show>", "2160p"],
      release: {
        trackerKey: "rutracker",
        externalId: "42",
        title: "The <Show> & Season 2",
        url: "https://rutracker.org/forum/viewtopic.php?t=42",
        coverUrl: "https://images.example/cover.jpg",
        magnet: `magnet:?xt=urn:btih:${hash}&dn=show`,
        torrentUrl: "https://rutracker.org/forum/dl.php?t=42",
        metadata: { size: "24.1 GB", category: "TV" },
      },
    });

    expect(telegram.canNotify(userId)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("sendPhoto");
    expect(calls[0].body).toMatchObject({
      chat_id: "12345",
      photo: "https://images.example/cover.jpg",
      parse_mode: "HTML",
    });
    expect(calls[0].body.caption).toContain("⚡ The &lt;Show&gt; &amp; Season 2");
    expect(calls[0].body.caption).toContain("Tracker: RuTracker");
    expect(calls[0].body.caption).toContain("Rule: The &lt;Show&gt; + 2160p");
    expect(calls[0].body.caption).toContain("Size: 24.1 GB");
    expect(calls[0].body.caption).toContain("Category: TV");
    expect(calls[0].body.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Tracker page", url: "https://rutracker.org/forum/viewtopic.php?t=42" },
        { text: "Magnet", url: `https://torrentinel.example/magnet/${hash.toUpperCase()}` },
      ]],
    });
    expect(db.prepare("SELECT outcome, delivery_method, telegram_message_id, tracker_key, external_id FROM telegram_deliveries").get()).toEqual({
      outcome: "delivered",
      delivery_method: "photo-url",
      telegram_message_id: 1,
      tracker_key: "rutracker",
      external_id: "42",
    });
  });

  it("uploads the artwork when Telegram cannot fetch its URL directly", async () => {
    const calls: TelegramCall[] = [];
    const { db, vault, userId } = notificationDatabase();
    const mediaFetcher: typeof fetch = async () => new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "4" },
    });
    const telegram = new TelegramService(
      db,
      vault,
      telegramFetcher(calls, "sendPhoto"),
      "https://torrentinel.example",
      mediaFetcher,
    );

    await telegram.notifyRelease(userId, {
      trackerName: "Rutor",
      changes: ["torrent file changed"],
      release: {
        trackerKey: "rutor",
        externalId: "88",
        title: "Updated release",
        url: "https://rutor.is/torrent/88",
        coverUrl: "https://protected.example/cover.jpg",
        torrentUrl: "https://rutor.is/download/88",
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["sendPhoto", "sendPhoto"]);
    expect(calls[1].multipart).toBe(true);
    expect(calls[1].body.caption).toContain("Changed: torrent file changed");
    expect(calls[1].body.photo).toBe("image/jpeg:4");
    expect(calls[1].body.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Tracker page", url: "https://rutor.is/torrent/88" },
        { text: "Torrent file", url: "https://rutor.is/download/88" },
      ]],
    });
    expect(db.prepare("SELECT outcome, delivery_method, telegram_message_id FROM telegram_deliveries").get()).toEqual({
      outcome: "delivered",
      delivery_method: "photo-upload",
      telegram_message_id: 2,
    });
  });

  it("retries cover retrieval through HTTPS/2 before falling back to text", async () => {
    const calls: TelegramCall[] = [];
    const { db, vault, userId } = notificationDatabase();
    const mediaFetcher: typeof fetch = async () => new Response("not found", { status: 404 });
    const http2MediaFetcher = async () => ({
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer as ArrayBuffer,
      contentType: "image/jpeg",
    });
    const telegram = new TelegramService(
      db,
      vault,
      telegramFetcher(calls, "sendPhoto"),
      "https://torrentinel.example",
      mediaFetcher,
      http2MediaFetcher,
    );

    await telegram.notifyRelease(userId, {
      trackerName: "RuTracker",
      release: {
        trackerKey: "rutracker",
        externalId: "6887455",
        title: "HTTP/2 cover retry",
        url: "https://rutracker.org/forum/viewtopic.php?t=6887455",
        coverUrl: "https://i128.fastpic.org/big/cover.jpg",
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["sendPhoto", "sendPhoto"]);
    expect(calls[1].multipart).toBe(true);
    expect(calls[1].body.photo).toBe("image/jpeg:4");
    const delivery = db.prepare(`
      SELECT outcome, delivery_method, telegram_message_id, artwork_error_message
      FROM telegram_deliveries
    `).get() as Record<string, unknown>;
    expect(delivery).toMatchObject({
      outcome: "delivered",
      delivery_method: "photo-upload",
      telegram_message_id: 2,
    });
    expect(delivery.artwork_error_message).toContain("failed to fetch photo");
    expect(delivery.artwork_error_message).toContain("cover download failed with HTTP 404");
  });

  it("uses a text notification only when both remote and uploaded artwork delivery fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: TelegramCall[] = [];
    const { db, vault, userId } = notificationDatabase();
    const mediaFetcher: typeof fetch = async () => new Response("blocked", { status: 403 });
    const telegram = new TelegramService(
      db,
      vault,
      telegramFetcher(calls, "sendPhoto"),
      "https://torrentinel.example",
      mediaFetcher,
      async () => { throw new Error("HTTPS/2 cover download failed with HTTP 404"); },
    );

    await telegram.notifyRelease(userId, {
      trackerName: "Rutor",
      release: {
        trackerKey: "rutor",
        externalId: "99",
        title: "Fallback release",
        url: "https://rutor.is/torrent/99",
        coverUrl: "https://blocked.example/cover.jpg",
        torrentUrl: "https://rutor.is/download/99",
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(calls[1].body.text).toContain("⚡ Fallback release");
    const delivery = db.prepare("SELECT outcome, delivery_method, telegram_message_id, artwork_error_message FROM telegram_deliveries").get() as Record<string, unknown>;
    expect(delivery).toMatchObject({
      outcome: "delivered",
      delivery_method: "text",
      telegram_message_id: 2,
    });
    expect(delivery.artwork_error_message).toContain("standard HTTPS fetch: cover download failed with HTTP 403");
    expect(delivery.artwork_error_message).toContain("HTTPS/2 retry: HTTPS/2 cover download failed with HTTP 404");
  });

  it("records a skipped delivery when Telegram is not linked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torrentinel-telegram-test-"));
    cleanup.push(directory);
    const db = createDatabase(join(directory, "test.db"));
    const vault = createSecretVault(join(directory, "master.key"));
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const telegram = new TelegramService(db, vault, telegramFetcher([]), "https://torrentinel.example");

    await telegram.notifyRelease(user.id, {
      trackerName: "Kinozal",
      release: {
        trackerKey: "kinozal",
        externalId: "101",
        title: "No destination",
        url: "https://kinozal.example/details.php?id=101",
      },
    });

    expect(db.prepare("SELECT outcome, delivery_method, error_message FROM telegram_deliveries").get()).toEqual({
      outcome: "skipped",
      delivery_method: "none",
      error_message: "Telegram bot or account link is not configured",
    });
  });

  it("records Telegram API failures without exposing the bot token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: TelegramCall[] = [];
    const { db, vault, userId } = notificationDatabase();
    const telegram = new TelegramService(
      db,
      vault,
      telegramFetcher(calls, "sendMessage"),
      "https://torrentinel.example",
    );

    await telegram.notifyRelease(userId, {
      trackerName: "Rutor",
      release: {
        trackerKey: "rutor",
        externalId: "102",
        title: "Failed destination",
        url: "https://rutor.is/torrent/102",
      },
    });

    expect(db.prepare("SELECT outcome, delivery_method, error_message FROM telegram_deliveries").get()).toEqual({
      outcome: "failed",
      delivery_method: "text",
      error_message: "failed to fetch photo",
    });
    expect(JSON.stringify(db.prepare("SELECT * FROM telegram_deliveries").get())).not.toContain("not-a-real-telegram-token");
  });
});

interface TelegramCall {
  method: string;
  body: Record<string, any>;
  multipart?: boolean;
}

function notificationDatabase(): { db: SqliteDatabase; vault: SecretVault; userId: string } {
  const directory = mkdtempSync(join(tmpdir(), "torrentinel-telegram-test-"));
  cleanup.push(directory);
  const db = createDatabase(join(directory, "test.db"));
  const vault = createSecretVault(join(directory, "master.key"));
  const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO telegram_bots
      (user_id, token_encrypted, bot_username, update_offset, configured_at, updated_at)
    VALUES (?, ?, 'torrentinel_test_bot', 0, ?, ?)
  `).run(user.id, vault.encrypt("not-a-real-telegram-token", telegramTokenAad(user.id)), timestamp, timestamp);
  db.prepare(`
    INSERT INTO telegram_accounts (user_id, chat_id, telegram_username, linked_at)
    VALUES (?, '12345', 'torrentinel_user', ?)
  `).run(user.id, timestamp);
  return { db, vault, userId: user.id };
}

function telegramFetcher(calls: TelegramCall[], failingMethod?: string): typeof fetch {
  return async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").at(-1) || "";
    const multipart = init?.body instanceof FormData;
    const body = multipart
      ? formBody(init.body)
      : JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ method, body, multipart });
    if (method === failingMethod && !multipart) {
      return new Response(JSON.stringify({ ok: false, description: "failed to fetch photo" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function formBody(form: FormData): Record<string, any> {
  const body: Record<string, any> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      body[key] = key === "reply_markup" ? JSON.parse(value) : value;
    } else {
      body[key] = `${value.type}:${value.size}`;
    }
  }
  return body;
}
