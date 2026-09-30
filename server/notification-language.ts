export type NotificationLanguage = "en" | "ru";
const russian: Record<string, string> = {
  "Tracker": "Трекер", "Rule": "Правило", "Changed": "Изменения", "Size": "Размер", "Category": "Категория",
  "All releases": "Все релизы", "Tracker page": "Страница трекера", "Torrent file": "Торрент-файл",
  "title changed": "изменено название", "cover changed": "изменена обложка", "magnet changed": "изменена magnet-ссылка",
  "torrent file changed": "изменён торрент-файл", "metadata changed": "изменены метаданные", "release data changed": "изменены данные релиза",
  "This link code is invalid or has expired. Generate a new code in Torrentinel.": "Код подключения неверен или истёк. Создайте новый код в Torrentinel.",
  "Torrentinel is linked. Subscription changes will be delivered to this chat.": "Torrentinel подключён. Уведомления об изменениях подписок будут приходить в этот чат.",
};
export function notificationText(language: NotificationLanguage, text: string): string { return language === "ru" ? russian[text] ?? text : text; }
