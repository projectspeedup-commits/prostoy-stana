// Тема оформления: тёмная или светлая. Обычный скрипт (не модуль).
// Стоит в <head> до стилей: выбранная тема ставится до первой отрисовки, страница не мигает.
// Встроенные скрипты и атрибут style запрещены политикой безопасности — поэтому отдельный файл.
// Выбор хранится в localStorage["stan.theme"]; пока выбора нет, тема идёт по настройке устройства.
(function () {
  "use strict";

  var KEY = "stan.theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (e) { return null; }
  }

  // Какая тема действует сейчас: выбранная вручную, иначе светлая (владелец, 01.10.2026)
  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  // Подпись кнопки #theme и цвет строки состояния браузера (meta theme-color)
  function sync() {
    var next = current() === "light" ? "dark" : "light";
    var btn = document.getElementById("theme");
    if (btn) {
      btn.setAttribute("aria-label", next === "light" ? "Светлая тема" : "Тёмная тема");
      btn.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
      btn.title = next === "light" ? "Переключить на светлую тему" : "Переключить на тёмную тему";
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    // Цвет берём из токена --bg, чтобы не дублировать значения; стили ещё не загрузились — оставляем как есть
    var bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (meta && bg) meta.setAttribute("content", bg);
  }

  function toggle() {
    var next = current() === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch (e) { /* память закрыта — тема действует до перезагрузки */ }
    sync();
  }

  // Без сохранённого выбора страница открывается в светлой теме
  root.setAttribute("data-theme", saved() || "light");

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme");
    if (btn) btn.addEventListener("click", toggle);
    sync();
  });
  // К этому времени стили точно загружены — цвет meta theme-color уточняем
  window.addEventListener("load", sync);
  // Устройство сменило тему, а выбора нет — подпись и цвет следуют за ним
  if (media) {
    if (media.addEventListener) media.addEventListener("change", sync);
    else if (media.addListener) media.addListener(sync);
  }
})();
