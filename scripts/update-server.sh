#!/usr/bin/env bash
# After committing and pushing changes, run on the server from any directory:
#   sudo bash /home/deploy/update-elonbot.sh
# If this script changes, pull and copy it to that path again (see README.md).
set -Eeuo pipefail
umask 077

SOURCE_DIR=/home/deploy/elonbot-source
APP_DIR=/opt/elonbot
SERVICE=elonbot
export PATH="/opt/node24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Запустите скрипт через sudo bash.'
for command in git tar node npm curl systemctl runuser flock mktemp stat; do
  command -v "$command" >/dev/null || die "Не найдена команда: $command"
done
exec 9>/run/lock/elonbot-update.lock
flock -n 9 || die 'Другое обновление уже выполняется.'
[[ -d "$SOURCE_DIR/.git" ]] || die "Нет Git-репозитория: $SOURCE_DIR"
[[ -d "$APP_DIR" && ! -L "$APP_DIR" && -f "$APP_DIR/.env" ]] || die "Нужен каталог $APP_DIR с существующим .env."
[[ $(systemctl show "$SERVICE" -p LoadState --value) == loaded ]] || die "Не найден сервис $SERVICE."
[[ $(systemctl show "$SERVICE" -p WorkingDirectory --value) == "$APP_DIR" ]] || die 'WorkingDirectory сервиса отличается от APP_DIR.'
node -e 'const v=+process.versions.node.split(".")[0]; process.exit(v>=22 && v<=24 ? 0 : 1)' || die 'Нужен Node.js 22–24.'

SOURCE_USER=$(stat -c '%U' "$SOURCE_DIR")
APP_USER=$(systemctl show "$SERVICE" -p User --value)
APP_USER=${APP_USER:-root}
repo() { runuser -u "$SOURCE_USER" -- git -C "$SOURCE_DIR" "$@"; }
[[ -z $(repo status --porcelain) ]] || die 'В серверном репозитории есть локальные изменения. Сохраните их перед обновлением.'
repo pull --ff-only
REVISION=$(repo rev-parse --short HEAD)

STAMP=$(date +%Y%m%d-%H%M%S)-$$
BACKUP="$APP_DIR.backup-$STAMP"
FAILED="$APP_DIR.failed-$STAMP"
STAGE=$(mktemp -d /opt/.elonbot-update.XXXXXX)
STOPPED=0

rollback() {
  local code=$1
  trap - ERR INT TERM
  set +e
  printf '\nОбновление не завершено. Подготовленные файлы: %s\n' "$STAGE" >&2
  if [[ -d "$BACKUP" ]]; then
    systemctl stop "$SERVICE"
    if [[ -e "$APP_DIR" ]]; then
      mv -T -- "$APP_DIR" "$FAILED" || { printf 'Не удалось убрать новую версию. Резервная копия: %s\n' "$BACKUP" >&2; exit "$code"; }
    fi
    if mv -T -- "$BACKUP" "$APP_DIR" && systemctl start "$SERVICE"; then
      printf 'Прежние файлы возвращены, сервис запущен. Миграции БД не откатывались.\n' >&2
    else
      printf 'Автоматический откат не завершён. Проверьте сервис и каталог %s.\n' "$BACKUP" >&2
    fi
  elif [[ $STOPPED -eq 1 ]]; then
    systemctl start "$SERVICE"
  fi
  exit "$code"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

printf 'Подготовка версии %s…\n' "$REVISION"
repo archive HEAD | tar -x -C "$STAGE"
[[ -f "$STAGE/app/main.ts" && -f "$STAGE/package-lock.json" ]]
chown -R "$APP_USER" "$STAGE"
(
  cd "$STAGE"
  runuser -u "$APP_USER" -- env PATH="$PATH" npm_config_cache="$STAGE/.npm-cache" npm ci --include=dev --no-audit --no-fund
  runuser -u "$APP_USER" -- env PATH="$PATH" npm run check
)
# Copy the existing configuration; never replace it with .env.example.
cp -p -- "$APP_DIR/.env" "$STAGE/.env"
chown "$APP_USER" "$STAGE/.env"
PORT=$(cd "$STAGE" && node -e '
  const fs=require("node:fs");
  const env=require("dotenv").parse(fs.readFileSync(".env"));
  const port=Number(env.PORT || 8000);
  if (!Number.isInteger(port) || port<1 || port>65535) process.exit(1);
  process.stdout.write(String(port));
')

printf 'Переключение версии; резервная копия: %s\n' "$BACKUP"
STOPPED=1
systemctl stop "$SERVICE"
mv -T -- "$APP_DIR" "$BACKUP"
mv -T -- "$STAGE" "$APP_DIR"
# The application applies pending migrations (including 008) before becoming ready.
systemctl start "$SERVICE"
HEALTHY=0
for ((attempt=1; attempt<=60; attempt++)); do
  if systemctl is-active --quiet "$SERVICE" && curl --fail --silent --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [[ $HEALTHY -ne 1 ]]; then
  printf 'Сервис не прошёл проверку готовности. Последние сообщения журнала:\n' >&2
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  rollback 1
fi
trap - ERR INT TERM
printf '\nОбновление до %s завершено. /health отвечает успешно.\nРезервная копия файлов: %s\n' "$REVISION" "$BACKUP"
systemctl status "$SERVICE" --no-pager --lines=5 || true
