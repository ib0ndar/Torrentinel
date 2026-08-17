import { customAlphabet } from "nanoid";
import { config } from "./config.js";
import {
  downloadCoverWithHttp2,
  type CoverAsset,
  type Http2CoverFetcher,
} from "./cover-http2.js";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { recordTelegramDelivery, type TelegramDeliveryInput } from "./diagnostics.js";
import { telegramTokenAad, type SecretVault } from "./secrets.js";
import type { Release } from "./types.js";

const linkCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);
const MAX_TELEGRAM_PHOTO_BYTES = 10_000_000;
const COVER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138 Safari/537.36";

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string; username?: string };
    from?: { username?: string };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
}

interface UploadedPhotoResult {
  message: TelegramMessage;
  coverFetchErrors?: string;
}

interface BotRow {
  user_id: string;
  token_encrypted: string;
  bot_username: string;
  update_offset: number;
}

interface BotWorker {
  controller: AbortController;
  promise: Promise<void>;
}

interface NotificationDestination {
  tokenEncrypted: string;
  chatId: string;
}

export interface ReleaseNotification {
  subscriptionId?: string;
  release: Release;
  trackerName: string;
  ruleTerms?: string[];
  changes?: string[];
}

export class TelegramService {
  private started = false;
  private readonly workers = new Map<string, BotWorker>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly vault: SecretVault,
    private readonly fetcher: typeof fetch = fetch,
    private readonly publicUrl = config.publicUrl,
    private readonly mediaFetcher: typeof fetch = fetch,
    private readonly http2MediaFetcher: Http2CoverFetcher = downloadCoverWithHttp2,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const rows = this.db.prepare(`
      SELECT user_id, token_encrypted, bot_username, update_offset FROM telegram_bots
    `).all() as BotRow[];
    for (const row of rows) {
      const token = this.vault.decrypt(row.token_encrypted, telegramTokenAad(row.user_id));
      this.startWorker(row.user_id, token, row.update_offset);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const userIds = [...this.workers.keys()];
    await Promise.all(userIds.map((userId) => this.stopWorker(userId)));
  }

  statusForUser(userId: string): {
    configured: boolean;
    botUsername?: string;
    linked: boolean;
    telegramUsername?: string;
  } {
    const bot = this.db.prepare("SELECT bot_username FROM telegram_bots WHERE user_id = ?")
      .get(userId) as { bot_username: string } | undefined;
    const account = this.db.prepare("SELECT telegram_username FROM telegram_accounts WHERE user_id = ?")
      .get(userId) as { telegram_username: string | null } | undefined;
    return {
      configured: Boolean(bot),
      botUsername: bot?.bot_username,
      linked: Boolean(account),
      telegramUsername: account?.telegram_username || undefined,
    };
  }

  configuredCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM telegram_bots").get() as { count: number }).count);
  }

  async configureBot(userId: string, token: string): Promise<ReturnType<TelegramService["statusForUser"]>> {
    const trimmedToken = token.trim();
    const me = await this.call<{ id: number; username?: string }>(trimmedToken, "getMe", {});
    if (!me.username) throw new Error("Telegram returned a bot without a username");

    const bots = this.db.prepare("SELECT user_id, token_encrypted FROM telegram_bots WHERE user_id <> ?")
      .all(userId) as Array<{ user_id: string; token_encrypted: string }>;
    for (const bot of bots) {
      const existingToken = this.vault.decrypt(bot.token_encrypted, telegramTokenAad(bot.user_id));
      if (existingToken === trimmedToken) throw new Error("This Telegram bot is already assigned to another Torrentinel user");
    }

    const existing = this.db.prepare("SELECT token_encrypted, configured_at, update_offset FROM telegram_bots WHERE user_id = ?")
      .get(userId) as { token_encrypted: string; configured_at: string; update_offset: number } | undefined;
    const tokenChanged = !existing || this.vault.decrypt(existing.token_encrypted, telegramTokenAad(userId)) !== trimmedToken;
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO telegram_bots
          (user_id, token_encrypted, bot_username, update_offset, configured_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          token_encrypted = excluded.token_encrypted,
          bot_username = excluded.bot_username,
          update_offset = excluded.update_offset,
          updated_at = excluded.updated_at
      `).run(
        userId,
        this.vault.encrypt(trimmedToken, telegramTokenAad(userId)),
        me.username,
        tokenChanged ? 0 : existing?.update_offset || 0,
        existing?.configured_at || timestamp,
        timestamp,
      );
      if (tokenChanged) {
        this.db.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").run(userId);
        this.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(userId);
      }
    })();

    if (this.started) {
      await this.stopWorker(userId);
      this.startWorker(userId, trimmedToken, tokenChanged ? 0 : existing?.update_offset || 0);
    }
    return this.statusForUser(userId);
  }

  async removeBot(userId: string): Promise<void> {
    await this.stopWorker(userId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM telegram_bots WHERE user_id = ?").run(userId);
    })();
  }

  createLink(userId: string): { code: string; expiresAt: string; deepLink: string } {
    const bot = this.db.prepare("SELECT bot_username FROM telegram_bots WHERE user_id = ?")
      .get(userId) as { bot_username: string } | undefined;
    if (!bot) throw new Error("Telegram bot is not configured");
    const code = linkCode();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ? OR expires_at <= ?")
      .run(userId, nowIso());
    this.db.prepare(`
      INSERT INTO telegram_link_codes (code, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(code, userId, expiresAt, nowIso());
    return {
      code,
      expiresAt,
      deepLink: `https://t.me/${bot.bot_username}?start=${code}`,
    };
  }

  unlink(userId: string): void {
    this.db.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(userId);
  }

  canNotify(userId: string): boolean {
    return Boolean(this.notificationDestination(userId));
  }

  async notifyUser(userId: string, html: string): Promise<void> {
    const startedMs = Date.now();
    const destination = this.notificationDestination(userId);
    if (!destination) {
      this.recordDelivery({
        userId,
        deliveryMethod: "none",
        outcome: "skipped",
        durationMs: Date.now() - startedMs,
        error: new Error("Telegram bot or account link is not configured"),
      });
      return;
    }
    try {
      const token = this.vault.decrypt(destination.tokenEncrypted, telegramTokenAad(userId));
      const message = await this.call<TelegramMessage>(token, "sendMessage", {
        chat_id: destination.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      this.recordDelivery({
        userId,
        deliveryMethod: "text",
        outcome: "delivered",
        telegramMessageId: message.message_id,
        durationMs: Date.now() - startedMs,
      });
    } catch (error) {
      this.recordDelivery({
        userId,
        deliveryMethod: "text",
        outcome: "failed",
        durationMs: Date.now() - startedMs,
        error,
      });
      console.error(`Telegram notification failed for user ${userId}:`, safeError(error));
    }
  }

  async notifyRelease(userId: string, notification: ReleaseNotification): Promise<void> {
    const startedMs = Date.now();
    const destination = this.notificationDestination(userId);
    if (!destination) {
      this.recordReleaseDelivery(userId, notification, {
        deliveryMethod: "none",
        outcome: "skipped",
        durationMs: Date.now() - startedMs,
        error: new Error("Telegram bot or account link is not configured"),
      });
      return;
    }

    const caption = releaseCaption(notification);
    const replyMarkup = releaseKeyboard(notification.release, this.publicUrl);
    let artworkError: string | undefined;
    try {
      const token = this.vault.decrypt(destination.tokenEncrypted, telegramTokenAad(userId));
      if (httpUrl(notification.release.coverUrl)) {
        try {
          const message = await this.call<TelegramMessage>(token, "sendPhoto", {
            chat_id: destination.chatId,
            photo: notification.release.coverUrl,
            caption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
          this.recordReleaseDelivery(userId, notification, {
            deliveryMethod: "photo-url",
            outcome: "delivered",
            telegramMessageId: message.message_id,
            durationMs: Date.now() - startedMs,
          });
          return;
        } catch (remotePhotoError) {
          try {
            const uploaded = await this.sendUploadedPhoto(
              token,
              destination.chatId,
              notification.release.coverUrl!,
              notification.release.url,
              caption,
              replyMarkup,
            );
            artworkError = combineErrors(remotePhotoError, uploaded.coverFetchErrors);
            this.recordReleaseDelivery(userId, notification, {
              deliveryMethod: "photo-upload",
              outcome: "delivered",
              telegramMessageId: uploaded.message.message_id,
              durationMs: Date.now() - startedMs,
              artworkError,
            });
            return;
          } catch (uploadedPhotoError) {
            artworkError = combineErrors(remotePhotoError, uploadedPhotoError);
            console.warn(
              `Telegram artwork delivery failed for user ${userId}; sending a text notification:`,
              artworkError,
            );
          }
        }
      }

      const message = await this.call<TelegramMessage>(token, "sendMessage", {
        chat_id: destination.chatId,
        text: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      this.recordReleaseDelivery(userId, notification, {
        deliveryMethod: "text",
        outcome: "delivered",
        telegramMessageId: message.message_id,
        durationMs: Date.now() - startedMs,
        artworkError,
      });
    } catch (error) {
      this.recordReleaseDelivery(userId, notification, {
        deliveryMethod: "text",
        outcome: "failed",
        durationMs: Date.now() - startedMs,
        error,
        artworkError,
      });
      console.error(`Telegram release notification failed for user ${userId}:`, safeError(error));
    }
  }

  private recordReleaseDelivery(
    userId: string,
    notification: ReleaseNotification,
    result: Omit<TelegramDeliveryInput, "userId" | "subscriptionId" | "trackerKey" | "externalId" | "title">,
  ): void {
    this.recordDelivery({
      ...result,
      userId,
      subscriptionId: notification.subscriptionId,
      trackerKey: notification.release.trackerKey,
      externalId: notification.release.externalId,
      title: notification.release.title,
    });
  }

  private recordDelivery(input: TelegramDeliveryInput): void {
    try {
      recordTelegramDelivery(this.db, input);
    } catch (error) {
      console.error("Could not persist Telegram delivery diagnostic:", safeError(error));
    }
  }

  private notificationDestination(userId: string): NotificationDestination | undefined {
    const row = this.db.prepare(`
      SELECT b.token_encrypted, a.chat_id
      FROM telegram_bots b JOIN telegram_accounts a ON a.user_id = b.user_id
      WHERE b.user_id = ?
    `).get(userId) as { token_encrypted: string; chat_id: string } | undefined;
    return row ? { tokenEncrypted: row.token_encrypted, chatId: row.chat_id } : undefined;
  }

  private async sendUploadedPhoto(
    token: string,
    chatId: string,
    coverUrl: string,
    releaseUrl: string,
    caption: string,
    replyMarkup: ReturnType<typeof releaseKeyboard>,
  ): Promise<UploadedPhotoResult> {
    const headers = {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: releaseUrl,
      "user-agent": COVER_USER_AGENT,
    };
    let asset: CoverAsset;
    let coverFetchErrors: string | undefined;
    try {
      const response = await this.mediaFetcher(coverUrl, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      asset = await coverAssetFromResponse(response);
    } catch (error) {
      const standardFetchError = safeError(error);
      try {
        asset = await this.http2MediaFetcher(coverUrl, {
          headers,
          maximumBytes: MAX_TELEGRAM_PHOTO_BYTES,
          timeoutMs: 20_000,
        });
      } catch (http2Error) {
        const { referer: _referer, ...headersWithoutReferer } = headers;
        try {
          asset = await this.http2MediaFetcher(coverUrl, {
            headers: headersWithoutReferer,
            maximumBytes: MAX_TELEGRAM_PHOTO_BYTES,
            timeoutMs: 20_000,
          });
        } catch (http2WithoutRefererError) {
          throw new Error([
            `standard HTTPS fetch: ${standardFetchError}`,
            `HTTPS/2 retry with referer: ${safeError(http2Error)}`,
            `HTTPS/2 retry without referer: ${safeError(http2WithoutRefererError)}`,
          ].join("; "));
        }
        coverFetchErrors = [
          `standard HTTPS fetch: ${standardFetchError}`,
          `HTTPS/2 retry with referer: ${safeError(http2Error)}`,
        ].join("; ");
      }
      coverFetchErrors ||= `standard HTTPS fetch: ${standardFetchError}`;
    }

    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("photo", new Blob([asset.bytes], { type: asset.contentType }), coverFilename(asset.contentType));
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    form.set("reply_markup", JSON.stringify(replyMarkup));
    const message = await this.callForm<TelegramMessage>(token, "sendPhoto", form);
    return { message, coverFetchErrors };
  }

  private startWorker(userId: string, token: string, offset: number): void {
    if (!this.started || this.workers.has(userId)) return;
    const controller = new AbortController();
    const worker: BotWorker = {
      controller,
      promise: Promise.resolve(),
    };
    worker.promise = this.pollLoop(userId, token, offset, controller.signal).finally(() => {
      if (this.workers.get(userId) === worker) this.workers.delete(userId);
    });
    this.workers.set(userId, worker);
  }

  private async stopWorker(userId: string): Promise<void> {
    const worker = this.workers.get(userId);
    if (!worker) return;
    worker.controller.abort();
    await worker.promise;
  }

  private async pollLoop(userId: string, token: string, initialOffset: number, signal: AbortSignal): Promise<void> {
    let offset = initialOffset;
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(token, "getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        }, 35_000, signal);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await this.handleUpdate(userId, token, update);
        }
        if (updates.length > 0) {
          this.db.prepare("UPDATE telegram_bots SET update_offset = ?, updated_at = ? WHERE user_id = ?")
            .run(offset, nowIso(), userId);
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error(`Telegram polling error for user ${userId}:`, safeError(error));
          await abortableDelay(5_000, signal);
        }
      }
    }
  }

  private async handleUpdate(userId: string, token: string, update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || message.chat.type !== "private") return;
    const match = message.text.trim().match(/^\/start(?:@\w+)?\s+([A-Z0-9]{8})$/i);
    if (!match) return;

    const code = match[1].toUpperCase();
    const link = this.db.prepare(`
      SELECT user_id FROM telegram_link_codes
      WHERE code = ? AND user_id = ? AND expires_at > ?
    `).get(code, userId, nowIso()) as { user_id: string } | undefined;
    if (!link) {
      await this.call(token, "sendMessage", {
        chat_id: message.chat.id,
        text: "This link code is invalid or has expired. Generate a new code in Torrentinel.",
      });
      return;
    }

    const timestamp = nowIso();
    const username = message.from?.username || message.chat.username || null;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").run(userId);
      this.db.prepare(`
        INSERT INTO telegram_accounts (user_id, chat_id, telegram_username, linked_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, String(message.chat.id), username, timestamp);
      this.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(userId);
    })();

    await this.call(token, "sendMessage", {
      chat_id: message.chat.id,
      text: "Torrentinel is linked. Subscription changes will be delivered to this chat.",
    });
  }

  private async call<T = unknown>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 15_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout,
    });
    const result = await response.json() as TelegramResponse<T>;
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram ${method} failed with HTTP ${response.status}`);
    }
    return result.result;
  }

  private async callForm<T = unknown>(token: string, method: string, body: FormData, timeoutMs = 30_000): Promise<T> {
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json() as TelegramResponse<T>;
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram ${method} failed with HTTP ${response.status}`);
    }
    return result.result;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineErrors(...errors: unknown[]): string | undefined {
  const messages = errors
    .filter((error) => error !== undefined && error !== null && error !== "")
    .map((error) => safeError(error));
  return messages.length > 0 ? messages.join("; ") : undefined;
}

async function coverAssetFromResponse(response: Response): Promise<CoverAsset> {
  if (!response.ok) throw new Error(`cover download failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (!contentType?.startsWith("image/")) throw new Error("cover URL did not return an image");
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (declaredLength > MAX_TELEGRAM_PHOTO_BYTES) throw new Error("cover exceeds Telegram's photo size limit");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_TELEGRAM_PHOTO_BYTES) throw new Error("cover exceeds Telegram's photo size limit");
  return { bytes, contentType };
}

export function escapeTelegram(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function releaseCaption(notification: ReleaseNotification): string {
  const { release } = notification;
  const lines = [
    `⚡ ${escapeTelegram(truncate(release.title, 700))}`,
    "",
    `Tracker: ${escapeTelegram(truncate(notification.trackerName, 80))}`,
  ];
  if (notification.ruleTerms) {
    lines.push(`Rule: ${escapeTelegram(truncate(notification.ruleTerms.join(" + ") || "All releases", 180))}`);
  } else if (notification.changes?.length) {
    lines.push(`Changed: ${escapeTelegram(truncate(notification.changes.join(", "), 180))}`);
  }

  const size = metadataText(release, "size");
  const category = metadataText(release, "category");
  if (size) lines.push(`Size: ${escapeTelegram(truncate(size, 80))}`);
  if (category) lines.push(`Category: ${escapeTelegram(truncate(category, 120))}`);
  return lines.join("\n");
}

function releaseKeyboard(release: Release, publicUrl: string | undefined) {
  const buttons: Array<{ text: string; url: string }> = [];
  const trackerUrl = httpUrl(release.url);
  if (trackerUrl) buttons.push({ text: "Tracker page", url: trackerUrl });

  const infoHash = magnetInfoHash(release.magnet);
  if (infoHash && publicUrl) {
    buttons.push({ text: "Magnet", url: `${publicUrl}/magnet/${encodeURIComponent(infoHash)}` });
  } else {
    const torrentUrl = httpUrl(release.torrentUrl);
    if (torrentUrl) buttons.push({ text: "Torrent file", url: torrentUrl });
  }
  return { inline_keyboard: [buttons.slice(0, 2)] };
}

function magnetInfoHash(magnet: string | undefined): string | undefined {
  if (!magnet) return undefined;
  try {
    const topic = new URL(magnet).searchParams.getAll("xt")
      .find((value) => value.toLocaleLowerCase("en-US").startsWith("urn:btih:"));
    const hash = topic?.slice("urn:btih:".length);
    return hash && /^(?:[a-f\d]{40}|[a-z2-7]{32})$/i.test(hash)
      ? hash.toLocaleUpperCase("en-US")
      : undefined;
  } catch {
    return undefined;
  }
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function metadataText(release: Release, field: string): string | undefined {
  const value = release.metadata?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}

function coverFilename(contentType: string): string {
  if (contentType === "image/png") return "cover.png";
  if (contentType === "image/webp") return "cover.webp";
  return "cover.jpg";
}
