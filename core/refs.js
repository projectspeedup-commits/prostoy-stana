import { DEFAULT_SCHEDULE } from "./core.js";

// Причины простоя — три блока без кодов классификатора (владелец, 30.09.2026).
// Подробности рабочий пишет своими словами, поэтому описание обязательно.
// Ключ причины — внутреннее имя, рабочему и в таблицу идёт название.
const reasons = {
  perevalka: {
    title: "Плановая", short: "Плановая", group: "Перевалка",
    planned: true, zone: "plan", noteRequired: true,
    hint: "Например: плановая перевалка валков второй клети",
    actionHint: "Например: установили валки второй клети, выставили зазор",
  },
  burezhka: {
    title: "Бурёжка", short: "Бурёжка", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: true,
    hint: "Например: заготовка застряла в чистовой группе, пятая клеть",
    actionHint: "Например: убрали застрявший раскат, выставили проводку",
  },
  avaria: {
    title: "Аварийный простой", short: "Аварийный простой", group: "Аварийный простой",
    planned: false, zone: "failure", noteRequired: true,
    hint: "Например: сломался привод третьей клети, течёт масло из редуктора",
    actionHint: "Например: заменили муфту привода, проверили стан на холостом ходу",
  },
};

export const DEFAULT_REFS = {
  reasons,
  tiles: [
    { id: "plan", title: "Плановая", subtitle: "перевалка валков и другие плановые остановки", zone: "plan", reason: "perevalka" },
    { id: "cobble", title: "Бурёжка", subtitle: "заготовка застряла, порыв раската", zone: "unplanned", reason: "burezhka" },
    { id: "failure", title: "Аварийный простой", subtitle: "поломка оборудования, отключение энергии", zone: "failure", reason: "avaria" },
  ].map(({ reason, ...tile }) => ({ ...tile, items: [{ code: reason, label: tile.title, text: "" }], codes: [reason] })),
  nodes: [
    "Склад заготовки, загрузка", "Нагревательная печь", "Черновая группа клетей",
    "Промежуточная группа клетей", "Чистовая группа клетей", "Летучие ножницы",
    "Холодильник", "Ножницы холодной резки", "Правильная машина",
    "Пакетирование, вязка, упаковка", "Краны", "Энергохозяйство", "АСУ ТП", "Стан в целом",
  ],
  settings: { shortStopMinutes: 5, schedule: DEFAULT_SCHEDULE },
};
