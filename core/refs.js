import { DEFAULT_SCHEDULE } from "./core.js";

// Классификатор простоев мелкосортного прокатного стана 300 (проект ООО «МПЗ», 2026).
// Рабочий выбирает плитку, затем пункт; описание своими словами обязательно только там, где noteRequired.
// askBillet — спрашивать брак при пуске. Ключ причины — внутреннее имя, в таблицу идёт название.
// perevalka и burezhka — скрытые: нет ни в одной плитке, нужны для записей, сделанных раньше.
const reasons = {
  plan_profile: {
    title: "Плановая: смена профиля (переход на новый профиль)", short: "Плановая: смена профиля", group: "Плановая",
    planned: true, zone: "plan", noteRequired: false, askBillet: false,
    hint: "Например: переход на новый профиль по графику",
    actionHint: "Например: заменили клети и проводки, настроили стан",
  },
  plan_maintenance: {
    title: "Плановая: профилактика оборудования", short: "Плановая: профилактика", group: "Плановая",
    planned: true, zone: "plan", noteRequired: false, askBillet: false,
    hint: "Например: плановая профилактика, износ калибров",
    actionHint: "Например: заменили калибры, смазали и почистили узлы",
  },
  plan_setup: {
    title: "Плановая: настройка стана и профиля", short: "Плановая: настройка стана", group: "Плановая",
    planned: true, zone: "plan", noteRequired: false, askBillet: false,
    hint: "Например: настройка после смены профиля, размер вне допуска",
    actionHint: "Например: подстроили зазоры, вывели размер в допуск",
  },
  plan_cooling: {
    title: "Плановая: смена режима охлаждения ТМУ", short: "Плановая: режим охлаждения ТМУ", group: "Плановая",
    planned: true, zone: "plan", noteRequired: false, askBillet: false,
    hint: "Например: смена режима ТМУ под новый заказ",
    actionHint: "Например: заменили секцию, изменили длину зоны охлаждения",
  },
  plan_other: {
    title: "Плановая: другое", short: "Плановая: другое", group: "Плановая",
    planned: true, zone: "plan", noteRequired: true, askBillet: false, other: true,
    hint: "Опишите, какой плановый простой",
    actionHint: "Например: выполнили работы по графику",
  },
  cobble_stand: {
    title: "Бурёжка в клети ТРИО или в клетях ДУО", short: "Бурёжка: в клети", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: true,
    hint: "Например: раскат застрял в третьей клети ДУО",
    actionHint: "Например: убрали лом, выставили проводку",
  },
  cobble_shears: {
    title: "Бурёжка в ножницах стана", short: "Бурёжка: в ножницах", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: true,
    hint: "Например: раскат не прошёл через летучие ножницы",
    actionHint: "Например: вырезали лом, проверили ножи",
  },
  cobble_tmu: {
    title: "Бурёжка в трассе ТМУ", short: "Бурёжка: в трассе ТМУ", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: true,
    hint: "Например: раскат застрял в секции охлаждения ТМУ",
    actionHint: "Например: вытащили лом, продули секцию",
  },
  cobble_coolbed: {
    title: "Бурёжка на холодильнике", short: "Бурёжка: на холодильнике", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: true,
    hint: "Например: раскат сбился на холодильнике",
    actionHint: "Например: убрали лом с холодильника краном",
  },
  cobble_other: {
    title: "Бурёжка в другом месте", short: "Бурёжка: другое место", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: true, askBillet: true, other: true,
    hint: "Опишите, где образовалась бурёжка",
    actionHint: "Например: убрали лом, проверили проводку",
  },
  avaria: {
    title: "Аварийный простой — выход из строя оборудования", short: "Аварийный простой", group: "Аварийный простой",
    planned: false, zone: "failure", noteRequired: true, askBillet: true,
    hint: "Например: сломался привод третьей клети, течёт масло из редуктора",
    actionHint: "Например: заменили муфту привода, проверили стан на холостом ходу",
  },
  tech_stands: {
    title: "Внеочередная замена клетей по выработке калибров", short: "Замена клетей", group: "Технологическая замена",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: false,
    hint: "Например: выработка калибров во второй клети",
    actionHint: "Например: заменили вторую клеть, выставили зазор",
  },
  tech_guides: {
    title: "Внеочередная замена привалковой арматуры, проводковых столов, воронок", short: "Замена арматуры и проводок", group: "Технологическая замена",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: false,
    hint: "Например: износ проводки перед пятой клетью",
    actionHint: "Например: заменили проводку и воронку",
  },
  tech_wear: {
    title: "Замена ножей, роликов рольгангов, столов холодильника, цепей", short: "Замена ножей, роликов, цепей", group: "Технологическая замена",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: false,
    hint: "Например: затупились ножи летучих ножниц",
    actionHint: "Например: заменили ножи, проверили рез",
  },
  tech_electric: {
    title: "Замена или регулировка датчиков, автоматов, преобразователей, моторредукторов", short: "Замена, регулировка электрики", group: "Технологическая замена",
    planned: false, zone: "unplanned", noteRequired: false, askBillet: false,
    hint: "Например: сбоит датчик наличия металла",
    actionHint: "Например: заменили датчик, проверили срабатывание",
  },
  failure_other: {
    title: "Поломка или замена: другое", short: "Поломка: другое", group: "Аварийный простой",
    planned: false, zone: "failure", noteRequired: true, askBillet: true, other: true,
    hint: "Опишите, что сломалось или что меняли",
    actionHint: "Например: заменили узел, проверили стан на холостом ходу",
  },
  perevalka: {
    title: "Плановая (вид не указан)", short: "Плановая (вид не указан)", group: "Плановая",
    planned: true, zone: "plan", noteRequired: true, askBillet: false,
    hint: "Например: плановая перевалка валков второй клети",
    actionHint: "Например: установили валки второй клети, выставили зазор",
  },
  burezhka: {
    title: "Бурёжка (место не указано)", short: "Бурёжка (место не указано)", group: "Бурёжка",
    planned: false, zone: "unplanned", noteRequired: true, askBillet: true,
    hint: "Например: заготовка застряла в чистовой группе, пятая клеть",
    actionHint: "Например: убрали застрявший раскат, выставили проводку",
  },
};

export const DEFAULT_REFS = {
  reasons,
  tiles: [
    { id: "plan", title: "Плановая", subtitle: "по план-графику: смена профиля, профилактика, настройка, охлаждение", zone: "plan",
      items: [{ code: "plan_profile", label: "Смена профиля", text: "" },
        { code: "plan_maintenance", label: "Профилактика оборудования", text: "" },
        { code: "plan_setup", label: "Настройка стана и профиля", text: "" },
        { code: "plan_cooling", label: "Смена режима охлаждения (ТМУ)", text: "" },
        { code: "plan_other", label: "Другое — напишу что", text: "" }],
      codes: ["plan_profile","plan_maintenance","plan_setup","plan_cooling","plan_other"] },
    { id: "cobble", title: "Бурёжка", subtitle: "раскат ушёл в лом: клеть, ножницы, ТМУ, холодильник", zone: "unplanned",
      items: [{ code: "cobble_stand", label: "В клети ТРИО или ДУО", text: "" },
        { code: "cobble_shears", label: "В ножницах", text: "" },
        { code: "cobble_tmu", label: "В трассе ТМУ", text: "" },
        { code: "cobble_coolbed", label: "На холодильнике", text: "" },
        { code: "cobble_other", label: "Другое место — напишу где", text: "" }],
      codes: ["cobble_stand","cobble_shears","cobble_tmu","cobble_coolbed","cobble_other"] },
    { id: "failure", title: "Поломка, замена оборудования", subtitle: "выход из строя, внеочередная замена клетей, арматуры, ножей, датчиков", zone: "failure",
      items: [{ code: "avaria", label: "Выход из строя оборудования", text: "" },
        { code: "tech_stands", label: "Замена клетей (выработка калибров)", text: "" },
        { code: "tech_guides", label: "Замена арматуры, проводковых столов, воронок", text: "" },
        { code: "tech_wear", label: "Замена ножей, роликов, столов холодильника, цепей", text: "" },
        { code: "tech_electric", label: "Замена или регулировка датчиков, автоматов, преобразователей, моторредукторов", text: "" },
        { code: "failure_other", label: "Другое — напишу что", text: "" }],
      codes: ["avaria","tech_stands","tech_guides","tech_wear","tech_electric","failure_other"] },
  ],
  nodes: [
    "Склад заготовки, загрузка", "Нагревательная печь", "Черновая группа клетей",
    "Промежуточная группа клетей", "Чистовая группа клетей", "Летучие ножницы",
    "Холодильник", "Ножницы холодной резки", "Правильная машина",
    "Пакетирование, вязка, упаковка", "Краны", "Энергохозяйство", "АСУ ТП", "Стан в целом",
  ],
  settings: { shortStopMinutes: 5, schedule: DEFAULT_SCHEDULE },
};
