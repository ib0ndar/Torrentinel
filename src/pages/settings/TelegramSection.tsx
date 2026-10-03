import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "../../api";
import { useDialog } from "../../components/Dialogs";
import { Icon } from "../../components/Icon";
import { ListSkeleton } from "../../components/UI";
import { errorMessage, relativeTime } from "../../format";
import { useVisibleInterval } from "../../hooks/useVisibleInterval";
import { useI18n } from "../../i18n";
import type { Notify, TelegramStatus } from "../../types";
import { SettingsSection } from "./SettingsSection";

type LinkCode = { code: string; expiresAt: string; deepLink?: string };

export function TelegramSection({ notify }: { notify: Notify }) {
  const { t } = useI18n(), dialog = useDialog();
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null), [link, setLink] = useState<LinkCode | null>(null);
  const [botToken, setBotToken] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => setTelegram((await api<{ telegram: TelegramStatus }>("/api/telegram")).telegram), []);
  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);
  // While a chat is being linked, watch for the link and drop an expired code.
  const pollLink = useCallback(() => {
    void api<{ telegram: TelegramStatus }>("/api/telegram").then((result) => setTelegram(result.telegram)).catch(() => undefined);
    setLink((current) => current && new Date(current.expiresAt).getTime() <= Date.now() ? null : current);
  }, []);
  useVisibleInterval(pollLink, telegram?.configured && !telegram.linked ? 5_000 : null);
  async function generateLink() {
    try { const result = await api<{ link: LinkCode }>("/api/telegram/link-code", { method: "POST" }); setLink(result.link); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function configureBot(event: FormEvent) {
    event.preventDefault();
    if (!botToken.trim() || busy) return;
    setBusy(true);
    try {
      const result = await api<{ telegram: TelegramStatus }>("/api/telegram/bot", { method: "POST", ...jsonBody({ token: botToken }) });
      setTelegram(result.telegram); setBotToken(""); setLink(null); notify(result.telegram.botUsername ? t("@{name} configured", { name: result.telegram.botUsername }) : t("Telegram bot configured"));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  async function removeBot() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Remove Telegram bot?"), description: t("This removes the stored bot token and unlinks the connected chat. Telegram notifications will stop until a bot is configured again."), confirmLabel: t("Remove bot"), tone: "danger" })) return;
    setBusy(true);
    try { await api("/api/telegram/bot", { method: "DELETE" }); setBotToken(""); setLink(null); await load(); notify(t("Telegram bot removed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  async function unlink() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Unlink this chat?"), description: t("Notifications to the connected Telegram chat will stop. The bot token remains stored and you can link a chat again later."), confirmLabel: t("Unlink chat"), tone: "danger" })) return;
    try { await api("/api/telegram", { method: "DELETE" }); setLink(null); await load(); notify(t("Telegram unlinked")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  return <SettingsSection id="telegram-bot" description={t("Create a bot with BotFather, store its token securely, then link the private chat that should receive changes.")}>
    <div className="settings-control">{!telegram ? <ListSkeleton /> : <div className="telegram-setup">
      <div className="integration-heading">
        <span className="telegram-mark"><Icon name="send" /></span>
        <span>
          <strong>{telegram.configured ? `@${telegram.botUsername}` : t("No bot configured")}</strong>
          <small>{t(telegram.configured ? "Token encrypted in the local database" : "BotFather issues the token used by Torrentinel")}</small>
        </span>
        <a className="button button--quiet" href="https://t.me/BotFather" target="_blank" rel="noreferrer"><Icon name="external" />{t("Create bot with BotFather")}</a>
      </div>
      <form className="telegram-token" onSubmit={(event) => void configureBot(event)}>
        <label className="settings-field">
          <span>{t(telegram.configured ? "Replace bot token" : "Bot token")}</span>
          <input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={t(telegram.configured ? "Stored securely — paste a token to replace" : "Paste the HTTP API token from BotFather")} autoComplete="new-password" />
        </label>
        <div className="integration-actions">
          <small>{t("The token is validated with Telegram before it is encrypted and saved.")}</small>
          {telegram.configured && <button type="button" className="text-button text-button--danger" disabled={busy} onClick={() => void removeBot()}>{t("Remove bot")}</button>}
          <button type="submit" className="button button--quiet" disabled={busy || !botToken.trim()}>{t(busy ? "Validating…" : telegram.configured ? "Replace token" : "Save bot")}</button>
        </div>
      </form>
      {telegram.configured && (telegram.linked ? <div className="linked-account">
        <span className="status-dot status-dot--live" />
        <span>
          <strong>{telegram.telegramUsername ? `@${telegram.telegramUsername}` : t("Telegram chat linked")}</strong>
          <small>{t("Notifications are active through @{name}", { name: telegram.botUsername || "" })}</small>
        </span>
        <button className="button button--quiet" onClick={() => void unlink()}>{t("Unlink chat")}</button>
      </div> : link ? <div className="link-code">
        <p>{t("Open @{name} and send /start {code}.", { name: telegram.botUsername || "", code: link.code })}</p>
        <strong>{link.code}</strong>
        {link.deepLink && <a className="button button--primary" href={link.deepLink} target="_blank" rel="noreferrer"><Icon name="send" />{t("Open Telegram")}</a>}
        <small>{t("Expires {time}", { time: relativeTime(link.expiresAt) })}</small>
      </div> : <div className="link-prompt">
        <span>
          <strong>{t("Bot saved. Chat not linked.")}</strong>
          <small>{t("Generate a one-time code to connect this Torrentinel account.")}</small>
        </span>
        <button className="button button--primary" onClick={() => void generateLink()}><Icon name="send" />{t("Link Telegram")}</button>
      </div>)}
    </div>}</div>
  </SettingsSection>;
}
