#!/bin/bash
# Выкладка демо-версии страницы на GitHub Pages (ветка gh-pages).
# На github.io страница сама включает имитацию сервера, данных завода там нет.
# Запуск из корня проекта: bash deploy/pages.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TEMP:-/tmp}/stan-pages"
URL="https://projectspeedup-commits.github.io/prostoy-stana/"

cd "$ROOT"
if [ ! -d "$WORK/.git" ] && [ ! -f "$WORK/.git" ]; then
  git worktree prune
  git worktree add -q "$WORK" gh-pages
fi

# Собираем сайт заново: страница рабочего без страницы пробы связи и ядро
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp app/public/{index.html,app.js,queue.js,tokens.css,app.css,pult.css,theme.js,charts.js,timeline.js,timeline.css,mock.js,sw.js,icon.svg,manifest.webmanifest} "$WORK/"
mkdir -p "$WORK/fonts"
cp app/public/fonts/* "$WORK/fonts/"
mkdir -p "$WORK/core"
cp app/public/{report-ui.js,report.css} "$WORK/"
cp app/core/{core.js,refs.js,stats.js,zones.js,settings.js,report-period.js,report.js,xlsx.js} "$WORK/core/"
touch "$WORK/.nojekyll"

cd "$WORK"
git add -A
if git diff --cached --quiet; then
  echo "Изменений для выкладки нет"
  exit 0
fi
SRC=$(git -C "$ROOT" log --oneline -1)
git commit -q -m "Демо из $SRC"
git push -q origin gh-pages

# Ждём, пока GitHub Pages начнёт отдавать новый app.js (кеш до 10 минут).
# Переводы строк не сравниваем: на Windows рабочая копия может быть в CRLF, а GitHub отдаёт LF
want=$(tr -d '\r' < "$ROOT/app/public/app.js" | sha1sum | cut -c1-40)
for i in $(seq 1 60); do
  got=$(curl -s "$URL/app.js?t=$(date +%s)" | tr -d '\r' | sha1sum | cut -c1-40)
  [ "$got" = "$want" ] && { echo "Выложено: $URL"; exit 0; }
  sleep 10
done
echo "Новая версия ещё не раздаётся, проверьте позже: $URL"
