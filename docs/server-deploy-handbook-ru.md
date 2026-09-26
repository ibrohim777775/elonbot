# Справочник: как развернуть сайт или бэкенд на Ubuntu VPS

Актуализировано: 26 сентября 2026 года. Основа примеров — Ubuntu 24.04 LTS, Caddy и systemd. Справочник подходит для других проектов и не зависит от Elonbot.

Команды ниже — шаблоны для выбранного проекта, а не один скрипт, который нужно выполнить целиком. На существующем сервере сохраняйте конфигурацию других сайтов. Если проект уже развёрнут другим способом, сначала сопоставьте пути и службы.

Все блоки `bash` выполняются внутри SSH на VPS, блоки `powershell` — на вашем Windows-компьютере. `set -euo pipefail` останавливает выполнение при ошибке; интерактивный SSH-сеанс при этом может закрыться. Подключитесь снова, исправьте причину и продолжите с нужного шага. Не пропускайте ошибку, чтобы перейти к публикации.

Проверены оглавление и синтаксис всех 33 Bash-блоков. На живом VPS эти примеры не запускались; перед применением замените имена, пути и команды запуска значениями своего проекта.

## Содержание

1. [Выбрать способ запуска](#1-выбрать-способ-запуска)
2. [Подготовить сервер и доступ](#2-подготовить-сервер-и-доступ)
3. [Подключить домен и Caddy](#3-подключить-домен-и-caddy)
4. [Подготовить Node.js и исходники](#4-подготовить-nodejs-и-исходники)
5. [Развернуть обычный сайт или React/Vue/Vite](#5-развернуть-обычный-сайт-или-reactvuevite)
6. [Развернуть Node.js-бэкенд](#6-развернуть-nodejs-бэкенд)
7. [Next.js и Python](#7-nextjs-и-python)
8. [Соединить сайт и API](#8-соединить-сайт-и-api)
9. [База данных, файлы и секреты](#9-база-данных-файлы-и-секреты)
10. [Обновить проект и откатить версию](#10-обновить-проект-и-откатить-версию)
11. [Если проект использует Docker](#11-если-проект-использует-docker)
12. [Проверки, логи и частые ошибки](#12-проверки-логи-и-частые-ошибки)
13. [Несколько проектов и короткая памятка](#13-несколько-проектов-и-короткая-памятка)

## 1. Выбрать способ запуска

| Что у вас | Что публикуется | Что постоянно работает на VPS |
|---|---|---|
| HTML, CSS, JavaScript | Папка с `index.html` и публичными файлами | Caddy |
| React/Vue через Vite без SSR | Результат `npm run build`, обычно `dist/` | Caddy |
| Next.js со статическим экспортом | Папка экспорта, обычно `out/` | Caddy |
| Next.js с SSR, серверными обработчиками | Собранное серверное приложение | Caddy + служба приложения |
| Express, NestJS, другой Node.js API | Серверный код и зависимости | Caddy + служба приложения |
| FastAPI, Django, другой Python API | Код, виртуальное окружение и зависимости | Caddy + ASGI/WSGI-служба |
| Проект с готовым Dockerfile/Compose | Контейнеры и постоянные тома | Caddy + Docker |

React сам по себе не определяет способ деплоя: Vite SPA можно раздавать как файлы, а SSR требует серверного процесса. `npm run dev`, `vite preview` и Python `--reload` не используются как production-серверы. [Развёртывание Vite](https://vite.dev/guide/static-deploy), [варианты Next.js](https://nextjs.org/docs/app/getting-started/deploying).

Схема статического сайта:

```text
Посетитель → домен → Caddy :443 → публичные HTML/CSS/JS
```

Схема бэкенда или SSR:

```text
Посетитель → домен → Caddy :443 → приложение 127.0.0.1:3000 → база
```

Для каждого проекта заранее запишите:

| Параметр | Пример в справочнике |
|---|---|
| IP VPS | `SERVER_IP` — заменить |
| Домен сайта | `site.example.com` — заменить |
| Домен API | `api.example.com` — заменить |
| Администратор Linux | `deploy` |
| Статический проект | `mysite` |
| Серверный проект / служба / пользователь | `myapp` |
| Порт серверного проекта | `3000`, другой проект — `3001` |
| Репозиторий | `REPOSITORY_URL` — заменить настоящим URL |
| Команда сборки | Из README и `package.json` проекта |
| Команда production-запуска | Например, `node dist/main.js` |
| Проверка готовности | Например, `GET /health` → HTTP 200 |

Пример `dist/main.js` не универсален: у вашего проекта может быть `dist/index.js`, `server.js` или другая команда. Уточните её до настройки службы.

## 2. Подготовить сервер и доступ

### 2.1. Первый вход и пакеты

На своём компьютере, в PowerShell:

```powershell
ssh root@SERVER_IP
```

Если хостинг выдал пользователя `ubuntu` или нестандартный порт, используйте их. Для порта 2222 у SSH параметр `-p 2222`, у scp — `-P 2222`. При первом входе сверяйте отпечаток сервера с панелью хостинга. Держите доступной веб-консоль VPS.

В SSH, на сервере:

```bash
cat /etc/os-release
uname -m
sudo apt update
sudo apt upgrade
sudo apt install git curl ca-certificates gnupg xz-utils unzip rsync nano ufw openssh-server unattended-upgrades
```

Если обновления требуют перезагрузки, выполните её в подходящий момент и подключитесь снова. На работающем сервере это затронет все проекты.

### 2.2. Пользователь deploy и SSH-ключ

На новом VPS создайте пользователя для управления:

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
```

Если `deploy` уже есть, используйте существующего после проверки доступа. Приложение будет работать от другого пользователя без sudo.

На Windows создайте отдельный ключ. Если файл с таким именем уже есть, не перезаписывайте его:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\vps_deploy"
scp "$env:USERPROFILE\.ssh\vps_deploy.pub" root@SERVER_IP:vps-deploy.pub
```

Передаётся только публичный файл `.pub`, в домашнюю папку первоначального пользователя. Если вы входили как `ubuntu`, в команде scp также замените `root` на `ubuntu`. В исходном SSH-окне на сервере:

```bash
sudo install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
sudo touch /home/deploy/.ssh/authorized_keys
sudo tee -a /home/deploy/.ssh/authorized_keys < "$HOME/vps-deploy.pub" > /dev/null
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Откройте **второе** окно PowerShell и проверьте:

```powershell
ssh -i "$env:USERPROFILE\.ssh\vps_deploy" deploy@SERVER_IP
```

В нём `whoami` должен показать `deploy`, а `sudo whoami` — `root`. Первое окно пока оставьте открытым.

После успешной проверки создайте `/etc/ssh/sshd_config.d/00-local-hardening.conf` через `sudo nano`:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Проверьте конфигурацию, примените её и снова протестируйте новый вход:

```bash
set -euo pipefail
sudo sshd -t
sudo sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
sudo systemctl reload ssh
```

При ошибке или неожиданных итоговых значениях сначала разберите другие настройки SSH. Не закрывайте рабочий сеанс до проверки нового. [Настройка OpenSSH в Ubuntu](https://ubuntu.com/server/docs/how-to/security/openssh-server/).

### 2.3. Firewall

Для нового VPS со стандартным SSH на порту 22:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status verbose
```

Для SSH на другом порту сначала разрешите именно его, например `sudo ufw allow 2222/tcp`. На существующем сервере дополнительно сохраните необходимые правила других служб. Такие же ограничения настройте в firewall хостинга. Порты приложений `3000/3001/8000`, PostgreSQL `5432` и Redis `6379` обычно не нужны извне. [UFW в Ubuntu](https://ubuntu.com/server/docs/how-to/security/firewalls/).

## 3. Подключить домен и Caddy

### 3.1. DNS

В панели DNS создайте `A` для нужного имени, указывающую на IPv4 VPS. Например, `site` → `SERVER_IP`, `api` → `SERVER_IP`. Для корня домена панель обычно использует `@`.

Добавляйте `AAAA` только при работающем публичном IPv6 и настроенной защите по IPv6. Неверная `AAAA` может ломать открытие сайта и выпуск сертификата. Не меняйте посторонние MX/TXT-записи.

На Windows проверьте:

```powershell
Resolve-DnsName site.example.com
Resolve-DnsName api.example.com
```

### 3.2. Установка Caddy

На VPS с ещё не установленным Caddy добавьте официальный репозиторий. В существующей установке сначала проверьте `caddy version` и источник пакета:

```bash
set -euo pipefail
sudo apt install debian-keyring debian-archive-keyring apt-transport-https
caddy_download_dir=$(mktemp -d)
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$caddy_download_dir/key.asc"
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$caddy_download_dir/caddy.list"
gpg --batch --dearmor --output "$caddy_download_dir/key.gpg" "$caddy_download_dir/key.asc"
sudo install -m 644 "$caddy_download_dir/key.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo install -m 644 "$caddy_download_dir/caddy.list" /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
sudo systemctl enable --now caddy
```

Основа установки — [официальный пакет Caddy для Ubuntu](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). Если уже используются Nginx/Apache на 80/443, сначала решите, какой веб-сервер будет принимать запросы: два сервера одновременно не займут один порт.

### 3.3. Изменение конфигурации

Основной файл — `/etc/caddy/Caddyfile`. Перед изменением сохраните копию:

```bash
sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup-$(date +%Y%m%d-%H%M%S)"
sudo nano /etc/caddy/Caddyfile
```

Добавьте блок своего домена из выбранного сценария ниже. Существующие блоки других доменов оставьте на месте. После каждого изменения:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Выполняйте reload только после успешной проверки. При обычной конфигурации публичного домена Caddy получает и обновляет HTTPS-сертификат сам. Для этого должны работать DNS, входящие 80/443 и исходящий доступ; адрес в конфигурации указывайте без `http://`. [Автоматический HTTPS](https://caddyserver.com/docs/automatic-https).

## 4. Подготовить Node.js и исходники

### 4.1. Node.js для Node/Vite/Next

Для обычного HTML-сайта и Python этот подпункт не нужен. Сначала проверьте `node --version` и требования `engines` проекта. Для production выбирайте поддерживаемую LTS. На дату справочника Node.js 24 относится к LTS; перед установкой сверяйте актуальный выпуск и совместимость. [Выпуски Node.js](https://nodejs.org/en/about/previous-releases).

Ниже пример установки официального Linux-бинарника `v24.21.0`. Если выбрали другой совместимый патч, замените `NODE_VERSION`. Путь `/opt/myapp-node` относится к этому проекту; его смена повлияет на службы, которые используют этот путь.

```bash
set -euo pipefail
NODE_VERSION=v24.21.0
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) printf 'Выберите сборку Node.js для вашей архитектуры.\n' >&2; exit 1 ;;
esac
node_download_dir=$(mktemp -d)
cd "$node_download_dir"
NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl --fail --show-error --location "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" -o "$NODE_ARCHIVE"
curl --fail --show-error --location "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o SHASUMS256.txt
awk -v file="$NODE_ARCHIVE" '$2 == file { print }' SHASUMS256.txt > selected.sha256
test -s selected.sha256
sha256sum --check selected.sha256
test ! -e "/opt/node-${NODE_VERSION}-linux-${NODE_ARCH}"
sudo tar --extract --xz --file "$NODE_ARCHIVE" --directory /opt --no-same-owner
sudo ln -sfnT "/opt/node-${NODE_VERSION}-linux-${NODE_ARCH}" /opt/myapp-node
export PATH="/opt/myapp-node/bin:$PATH"
node --version
npm --version
```

Если такая версия уже установлена, повторно распаковывать её не нужно: проверьте существующую установку. Контрольная сумма сверяется с файлом, полученным с официального HTTPS-сервера. Здесь не запускается скачанный shell-скрипт с правами root.

В новом SSH-сеансе для команд сборки снова выполните `export PATH="/opt/myapp-node/bin:$PATH"`. В systemd позже будет указан абсолютный путь — служба не зависит от настроек вашего интерактивного терминала.

### 4.2. Репозиторий

Под `deploy` клонируйте нужный проект, выбрав имя папки:

```bash
git clone REPOSITORY_URL /home/deploy/myapp-source
```

Для статического сайта в дальнейших примерах используется `/home/deploy/mysite-source`. Клонируйте его туда вместо `myapp-source`. В monorepo учитывайте подпапки приложения при сборке.

Для закрытого репозитория настройте отдельный read-only deploy key или другой ограниченный доступ. Не вставляйте токен в URL команды или README и не запускайте Git через sudo. В репозитории должны быть lock-файлы зависимостей; `.env`, приватные ключи и рабочие данные туда не добавляются.

## 5. Развернуть обычный сайт или React/Vue/Vite

### 5.1. Каталоги и сборка

Один раз создайте каталог публичных релизов:

```bash
sudo install -d -o deploy -g caddy -m 2755 /srv/mysite /srv/mysite/releases
```

Под `deploy` получите изменения сайта; этот блок нужен и для Vite, и для обычного HTML:

```bash
set -euo pipefail
cd /home/deploy/mysite-source
test -z "$(git status --porcelain)"
git pull --ff-only
```

Для Vite затем выполните сборку:

```bash
set -euo pipefail
export PATH="/opt/myapp-node/bin:$PATH"
cd /home/deploy/mysite-source
npm ci --include=dev
npm run build
test -s dist/index.html
```

При HTML/CSS/JS без сборки npm-блок не нужен: подготовьте отдельную папку `public-site/`, содержащую только публичные файлы сайта. Не публикуйте весь Git-репозиторий.

Для Vite каталог результата по умолчанию — `dist/`. Проверяйте `build.outDir`, если настройка изменена. Серверу не нужны `node_modules` для раздачи такого результата. [Сборка и публикация Vite](https://vite.dev/guide/static-deploy).

### 5.2. Публикация новой версии

В том же SSH-сеансе, под `deploy`:

```bash
set -euo pipefail
cd /home/deploy/mysite-source
STATIC_OUTPUT=dist
# Для обычного HTML-сайта замените dist на public-site.
test -s "$STATIC_OUTPUT/index.html"
STATIC_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
STATIC_RELEASE="/srv/mysite/releases/$STATIC_RELEASE_ID"
mkdir -m 755 -- "$STATIC_RELEASE"
rsync -rltp --chmod=D755,F644 "$STATIC_OUTPUT/" "$STATIC_RELEASE/"
test -s "$STATIC_RELEASE/index.html"
test ! -e /srv/mysite/current || test -L /srv/mysite/current
ln -sfnT "$STATIC_RELEASE" /srv/mysite/current.new
mv -Tf /srv/mysite/current.new /srv/mysite/current
```

`current` — ссылка на опубликованную версию. Новый каталог готовится отдельно, после чего ссылка переключается. Предыдущие каталоги остаются для отката. Выполняйте обновления одного проекта по одному, без параллельных запусков этих команд.

В публичной сборке не должно быть `.env`, исходных приватных файлов или секретов. Любые значения, встроенные в клиентский JavaScript, доступны посетителю; `VITE_*` и другие публичные переменные не подходят для пароля БД, токена бота и приватных API-ключей. [Переменные окружения Vite](https://vite.dev/guide/env-and-mode).

### 5.3. Caddy: обычный сайт

Добавьте в Caddyfile:

```caddyfile
site.example.com {
    root * /srv/mysite/current
    encode zstd gzip
    file_server
}
```

Для SPA с маршрутами вроде `/profile` используйте такой блок вместо предыдущего:

```caddyfile
site.example.com {
    root * /srv/mysite/current
    encode zstd gzip
    try_files {path} /index.html
    file_server
}
```

`try_files` нужен клиентскому роутеру SPA. Для обычного многостраничного сайта он может скрыть настоящие 404, поэтому автоматически его не добавляйте. [Типовые конфигурации Caddy](https://caddyserver.com/docs/caddyfile/patterns).

Проверьте и перезагрузите Caddy по пункту 3.3, затем откройте сайт и одну вложенную страницу. При последующем переключении `current` перезагрузка Caddy обычно не требуется: конфигурация не меняется.

## 6. Развернуть Node.js-бэкенд

### 6.1. Отдельный пользователь и каталоги

Один раз для нового проекта:

```bash
sudo useradd --system --user-group --home-dir /var/lib/myapp --shell /usr/sbin/nologin myapp
sudo install -d -o deploy -g myapp -m 2750 /srv/myapp /srv/myapp/releases
sudo install -d -o myapp -g myapp -m 750 /var/lib/myapp
sudo install -d -o root -g root -m 700 /etc/myapp
```

Если пользователь или каталоги уже существуют, сначала проверьте их назначение. `deploy` собирает и обновляет код; `myapp` запускает приложение и не имеет sudo. Рабочие файлы и загрузки хранятся в `/var/lib/myapp`, вне каталогов релизов.

### 6.2. Секреты и настройки

Создайте новый файл только при его отсутствии:

```bash
sudo sh -c 'umask 077; set -C; : > /etc/myapp/myapp.env'
sudo nano /etc/myapp/myapp.env
```

Если файл уже есть, пропустите создание и откройте его редактором. Пример содержимого:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
# Добавьте реальные переменные, которые читает именно ваше приложение.
# DATABASE_URL=postgresql://...
```

Служба получит переменные через systemd. Приложение должно читать `process.env`; не все программы сами учитывают `HOST` и `PORT`. Если оно всегда слушает `0.0.0.0`, исправьте настройку или код запуска. Не добавляйте `export` в файл `EnvironmentFile` и не используйте там shell-подстановки.

Права:

```bash
sudo chown root:root /etc/myapp/myapp.env
sudo chmod 600 /etc/myapp/myapp.env
```

Системный менеджер systemd читает этот файл до запуска процесса под `myapp`. Самому приложению не требуется читать файл напрямую. Если фреймворк требует физический `.env`, настройте это отдельно, не делая секреты общедоступными. [Окружение процессов systemd](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml).

### 6.3. Подготовить релиз

Под `deploy`:

```bash
set -euo pipefail
umask 027
export PATH="/opt/myapp-node/bin:$PATH"
cd /home/deploy/myapp-source
test -z "$(git status --porcelain)"
git pull --ff-only
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
RELEASE="/srv/myapp/releases/$RELEASE_ID"
mkdir -- "$RELEASE"
git archive HEAD | tar -x -C "$RELEASE"
cd "$RELEASE"
npm ci --include=dev
npm run build
test -s dist/main.js
```

Замените `dist/main.js` реальным файлом запуска. Если сборки у проекта нет, пропустите `npm run build` и проверяйте нужный JS-файл. Yarn/pnpm требуют своих команд с lock-файлом; не смешивайте менеджеры пакетов. Проектные проверки запускайте с тестовым окружением, не с рабочей БД.

Ни `npm ci`, ни сборка, ни импорт библиотек приложения не выполняются через sudo. Production-секреты в сборку по умолчанию не передаются.

### 6.4. Служба systemd

Создайте `sudo nano /etc/systemd/system/myapp.service`:

```ini
[Unit]
Description=My application
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/srv/myapp/current
EnvironmentFile=/etc/myapp/myapp.env
Environment=PATH=/opt/myapp-node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/myapp-node/bin/node /srv/myapp/current/dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=myapp
StateDirectoryMode=0750
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

Этот пример рассчитан на приложение, которому не нужна запись в код релиза. `StateDirectory` оставляет рабочий каталог `/var/lib/myapp` доступным для записи; настройте в приложении путь загрузок туда. Служба переживёт закрытие SSH и запустится после перезагрузки VPS.

Подключите подготовленный `$RELEASE` из пункта 6.3. Если открыли новый SSH-сеанс, сначала задайте `RELEASE` точным путём готового релиза:

```bash
set -euo pipefail
test -s "$RELEASE/dist/main.js"
test ! -e /srv/myapp/current || test -L /srv/myapp/current
ln -sfnT "$RELEASE" /srv/myapp/current.new
mv -Tf /srv/myapp/current.new /srv/myapp/current
sudo systemd-analyze verify /etc/systemd/system/myapp.service
sudo systemctl daemon-reload
sudo systemctl enable --now myapp
```

`enable --now` подходит для первого запуска. Обновление уже работающей службы требует `restart`, как в разделе 10. Если приложению нужны миграции, до включения службы выполните пункт 9.2.

### 6.5. Проверить и открыть API

```bash
sudo systemctl status myapp --no-pager
sudo journalctl -u myapp -n 80 --no-pager
curl --fail --show-error http://127.0.0.1:3000/health
sudo ss -lntp
```

`/health` — пример: такой endpoint нужно реализовать в приложении или заменить реальным адресом проверки. Ожидается HTTP 200, а в `ss` — `127.0.0.1:3000`. Ответ 404 на `/` сам по себе не означает, что API сломан.

После локальной проверки добавьте в Caddyfile:

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Проверьте конфигурацию, выполните reload и проверьте `https://api.example.com/health`. Caddy передаёт путь запроса приложению и формирует proxy-заголовки. В приложении доверяйте адресам и протоколу из заголовков только от известного прокси; режим доверия любому отправителю не подходит. [Документация reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## 7. Next.js и Python

### 7.1. Next.js с серверным рендерингом

Используйте подготовку Node.js, пользователя и релизов из раздела 6. Соберите через `npm ci --include=dev` и `npm run build`. Для стандартного Next.js вместо проверки `dist/main.js` проверяйте `.next/BUILD_ID`, а `ExecStart` в unit замените на:

```ini
ExecStart=/opt/myapp-node/bin/node /srv/myapp/current/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000
```

Это пример для обычного `next start`, не для `output: 'standalone'`. При standalone используйте созданный `server.js` и комплект файлов, который требует этот режим. [Способы деплоя Next.js](https://nextjs.org/docs/app/getting-started/deploying).

Для стандартного self-hosting Next.js может записывать кэш изображений и ISR в `.next`. Общий unit с readonly-релизом потребует настройки записи. Для первого одиночного сервера допустимо разрешить запись в `.next` этого релиза:

```bash
# Под deploy; RELEASE — точный каталог подготовленного Next.js-релиза.
test -s "$RELEASE/.next/BUILD_ID"
chmod -R g+rwX "$RELEASE/.next"
```

Добавьте в `[Service]`:

```ini
ReadWritePaths=/srv/myapp/current/.next
```

Группа `.next` должна быть `myapp`, как у релиза с наследованием группы в пункте 6.1. Это сознательно делает `.next` изменяемой службой. Для нескольких экземпляров и более строгой изоляции настройте внешний cache handler по документации Next.js. Не копируйте старый build-кэш в новую версию вслепую. [Кэш и self-hosting Next.js](https://nextjs.org/docs/app/guides/self-hosting).

Публичные `NEXT_PUBLIC_*` подготавливаются для браузера при сборке; смена runtime-переменной не перепишет уже собранный клиент. Секреты в эти переменные не помещают.

### 7.2. Python / FastAPI

Пользователь, каталоги, env и Caddy — по той же схеме. Сверьте требуемую версию Python с `pyproject.toml` или README проекта. Если подходит Python из Ubuntu, установите его и поддержку окружений:

```bash
sudo apt install python3 python3-venv
```

Вместо npm-команд в новом каталоге `$RELEASE`:

```bash
set -euo pipefail
cd "$RELEASE"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
```

Виртуальное окружение создаётся сразу в постоянном каталоге релиза: его нельзя переносить как обычную папку между разными путями. Фиксируйте зависимости; если проект использует `uv.lock` или Poetry, применяйте его штатную команду установки.

Для FastAPI с `app` в файле `main.py` замените `ExecStart`:

```ini
ExecStart=/srv/myapp/current/.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 3000 --proxy-headers --forwarded-allow-ips=127.0.0.1
```

Uvicorn должен быть зависимостью проекта. Для `app/main.py` объект обычно указывается как `app.main:app`. Не добавляйте `--reload` в production. Проверку готового релиза и локальный health адаптируйте под Python-приложение. Для Django нужны его production ASGI/WSGI-сервер, `ALLOWED_HOSTS`, CSRF-настройки и сборка статики — `manage.py runserver` для этого не подходит. [Запуск FastAPI](https://fastapi.tiangolo.com/deployment/manually/).

## 8. Соединить сайт и API

### Вариант A: один домен

Браузер открывает `https://site.example.com`, а API вызывается относительным адресом `/api/...`. Для SPA:

```caddyfile
site.example.com {
    @api path /api /api/*
    handle @api {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        root * /srv/mysite/current
        try_files {path} /index.html
        file_server
    }
}
```

Здесь бэкенд получает путь `/api/...` целиком. Если его маршруты начинаются с `/users`, а клиент обращается к `/api/users`, требуется согласованное удаление префикса, например `handle_path /api/*`. Не меняйте префикс без проверки маршрутов. Разделение `handle` также не даёт SPA подменить ошибку API страницей `index.html`. [Шаблоны маршрутизации Caddy](https://caddyserver.com/docs/caddyfile/patterns).

### Вариант B: отдельный api.example.com

Используйте два блока Caddy из разделов 5 и 6. Во фронтенде укажите публичный HTTPS-адрес API. В бэкенде настройте CORS для точного origin сайта; при cookie-авторизации согласуйте credentials, cookie и защиту от CSRF. Не используйте `*` вместе с пользовательскими credentials.

Адрес `localhost:3000` в браузерном JavaScript означает компьютер посетителя, а не ваш VPS. Для браузера нужен `/api` либо публичный домен API. Изменение встроенного адреса API во фронтенде обычно требует новой сборки.

## 9. База данных, файлы и секреты

### 9.1. PostgreSQL на том же VPS

Для нового приложения при необходимости:

```bash
sudo apt install postgresql
sudo -u postgres createuser --pwprompt myapp_db
sudo -u postgres createdb --owner=myapp_db myapp_db
```

Если роль или база уже есть, не пересоздавайте их. Пароль задаётся интерактивно, не строкой команды. В env приложения сохраните строку подключения к `127.0.0.1:5432`; специальные символы пароля в URL должны быть percent-encoded. Используйте отдельную БД/роль для каждого проекта. Это роль приложения, не PostgreSQL-superuser.

База не должна слушать публичный адрес без необходимости; дополнительно проверьте `pg_hba.conf`, `ss -lntp` и firewall. Для управляемой удалённой БД используйте требования провайдера к TLS с проверкой сертификата.

Загрузки пользователей, SQLite и другие изменяемые файлы размещайте вне release-папки — например, `/var/lib/myapp/uploads`. Путь задаётся в настройках самого приложения. Переключение `current` не должно удалять эти данные.

### 9.2. Миграции

Перед изменением схемы сделайте проверенный бэкап. Команда миграции зависит от проекта: например, `prisma migrate deploy`, `alembic upgrade head` или собственный скрипт. Не подменяйте её командой создания новой пустой БД.

Команду запускайте от `myapp` с production-окружением. Для Node-проекта, у которого **действительно есть** `npm run migrate`, пример одноразового запуска из подготовленного `$RELEASE`:

```bash
sudo systemd-run --wait --collect --pipe \
  --uid=myapp --gid=myapp \
  --working-directory="$RELEASE" \
  --property=EnvironmentFile=/etc/myapp/myapp.env \
  --setenv=PATH=/opt/myapp-node/bin:/usr/local/bin:/usr/bin:/bin \
  /opt/myapp-node/bin/npm run migrate
```

Сначала убедитесь, что миграция совместима с ещё работающей старой версией. Если нет — нужна остановка приложения на время миграции и заранее подготовленный план восстановления. При безопасных расширяющих миграциях новую схему можно подготовить до переключения процесса. Откат кода не откатывает автоматически базу.

Параметры одноразового запуска описаны в [руководстве systemd-run](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml).

### 9.3. Резервные копии

Пример одного ручного дампа локального PostgreSQL:

```bash
set -euo pipefail
umask 077
mkdir -p /home/deploy/backups
DB_BACKUP="/home/deploy/backups/myapp-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo -u postgres pg_dump --format=custom myapp_db > "$DB_BACKUP"
test -s "$DB_BACKUP"
pg_restore --list "$DB_BACKUP" > /dev/null
```

Дамп содержит данные одной БД; роли PostgreSQL и внешние файлы в него не входят. Проверка списка подтверждает читаемость архива, но не заменяет тестовое восстановление. Для проверки восстановите дамп в отдельную пустую тестовую БД и проверьте приложение. [Возможности pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html).

Настройте регулярные копии БД и `/var/lib/myapp`, шифрование, срок хранения, копию вне VPS и уведомление о сбоях. Секреты и ключи шифрования резервируйте отдельно с ограниченным доступом. Каталоги прошлых релизов — способ откатить код, а не бэкап пользовательских данных.

## 10. Обновить проект и откатить версию

### 10.1. Что делать перед каждым обновлением

На компьютере сохраните нужные изменения в Git и отправьте их в репозиторий. Сервер получает только опубликованные коммиты. Если серверный `git status` показывает локальные изменения, разберите их; не используйте `git reset --hard` как универсальное решение.

Проверьте миграции, наличие бэкапа и свободное место. Установка зависимостей и сборка должны завершиться до остановки работающего приложения.

Обновления одного проекта выполняйте последовательно: не запускайте эти блоки одновременно из двух SSH-сеансов или из SSH и CI.

### 10.2. Обновление статического сайта

Повторите сборку из 5.1 и публикацию из 5.2. До переключения запишите старый путь:

```bash
readlink -f /srv/mysite/current
```

После переключения проверьте сайт, вложенные маршруты, изображения и обращения к API. У открытых старых вкладок могут оставаться ссылки на JS/CSS прежней сборки: хранение старого каталога само по себе не делает эти файлы доступными по новому `current`. Для непрерывной работы старых вкладок нужен отдельный способ сохранения versioned assets/CDN либо обработка ошибки загрузки с предложением обновить страницу.

### 10.3. Обновление Node.js-бэкенда с проверкой и откатом

Подготовьте новый `$RELEASE` по 6.3, выполните нужные проверки и миграции. Затем, в том же SSH-сеансе под `deploy`:

```bash
set -euo pipefail
test -s "$RELEASE/dist/main.js"
PREVIOUS_RELEASE=$(readlink -f /srv/myapp/current)
case "$PREVIOUS_RELEASE" in
  /srv/myapp/releases/*) ;;
  *) printf 'Проверьте текущий путь приложения.\n' >&2; exit 1 ;;
esac
ln -sfnT "$RELEASE" /srv/myapp/current.new
mv -Tf /srv/myapp/current.new /srv/myapp/current

wait_ready() {
  for attempt in $(seq 1 30); do
    if sudo systemctl is-active --quiet myapp && \
       curl --fail --silent --max-time 2 http://127.0.0.1:3000/health > /dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! sudo systemctl restart myapp || ! wait_ready; then
  sudo journalctl -u myapp -n 60 --no-pager || true
  ln -sfnT "$PREVIOUS_RELEASE" /srv/myapp/current.new
  mv -Tf /srv/myapp/current.new /srv/myapp/current
  sudo systemctl restart myapp
  if ! wait_ready; then
    printf 'Прежний код возвращён, но готовность не подтверждена. Проверьте журнал и БД.\n' >&2
    exit 1
  fi
  printf 'Новая версия не готова. Возвращён прежний код; схема БД не откатывалась.\n' >&2
  exit 1
fi
printf 'Новая версия запущена. Предыдущий релиз: %s\n' "$PREVIOUS_RELEASE"
```

Этот блок рассчитан на уже работающий Node.js-проект из раздела 6. Для Next/Python замените проверку файла. Подберите срок ожидания под время запуска приложения. После локальной проверки отдельно проверьте публичный HTTPS и главную функцию проекта.

Перезапуск даёт короткий перерыв в обслуживании. Для обновления без такого перерыва нужны два экземпляра, переключение трафика, совместимые миграции и согласованное состояние. Это отдельная схема, не свойство одного `systemctl restart`.

### 10.4. Ручной откат

Посмотрите сохранённые версии и выберите точную:

```bash
ls -1 /srv/myapp/releases
readlink -f /srv/myapp/current
```

Замените `RELEASE_TO_RESTORE` реальным именем каталога:

```bash
set -euo pipefail
RESTORE_RELEASE=/srv/myapp/releases/RELEASE_TO_RESTORE
test -s "$RESTORE_RELEASE/dist/main.js"
ln -sfnT "$RESTORE_RELEASE" /srv/myapp/current.new
mv -Tf /srv/myapp/current.new /srv/myapp/current
sudo systemctl restart myapp
curl --fail --show-error --retry 15 --retry-connrefused --retry-delay 2 --max-time 2 http://127.0.0.1:3000/health
```

Для статики используйте `/srv/mysite`, проверяйте `index.html` и пропустите restart. Старые релизы удаляйте только после проверки текущего и выбранного резервного пути; в справочнике намеренно нет команды безусловной очистки каталогов.

Если менялся только env приложения — нужен `sudo systemctl restart myapp`. Если менялся unit — сначала `systemd-analyze verify`, затем `daemon-reload` и restart. Если менялся Caddyfile — validate и reload Caddy.

## 11. Если проект использует Docker

Используйте этот вариант, когда в проекте уже есть проверенные production `Dockerfile` и `compose.yml`. Он заменяет systemd-службу самого приложения из раздела 6; Caddy может остаться на хосте. Установку Docker Engine и Compose plugin выполняйте по [официальной инструкции для Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

Для Caddy на хосте публикуйте порт контейнера только на loopback:

```yaml
services:
  app:
    image: REGISTRY/PROJECT:RELEASE_TAG
    restart: unless-stopped
    env_file:
      - /etc/myapp/container.env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - app_data:/app/data

volumes:
  app_data:
```

Это фрагмент для адаптации: образ, переменные, путь данных, UID и права тома зависят от приложения. **Внутри контейнера** приложение должно слушать `0.0.0.0:3000`; ограничение внешнего доступа задаётся слева в `ports`. Публикация просто `3000:3000` обычно открывает порт наружу. Не полагайтесь только на UFW для Docker-портов. [Публикация портов Docker](https://docs.docker.com/engine/network/port-publishing/).

Если Caddy тоже в Compose, используйте общую сеть и `reverse_proxy app:3000`; приложение можно вообще не публиковать на хост. `127.0.0.1` внутри контейнера относится к нему самому. [Caddy в Docker](https://caddyserver.com/docs/running#docker-compose).

После замены образа на конкретный новый тег:

```bash
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 app
curl --fail --show-error http://127.0.0.1:3000/health
```

Выполняйте команды из каталога с нужным Compose-файлом. `config --quiet` проверяет его без печати развёрнутых секретов. Эти команды предполагают готовые образы; для `build:` нужен отдельный этап сборки. Для отката верните предыдущий фиксированный тег или digest и повторите `up -d`. БД автоматически не откатывается. `down -v` удаляет тома и не является обычным обновлением. [Проверка Compose-конфигурации](https://docs.docker.com/reference/cli/docker/compose/config/).

## 12. Проверки, логи и частые ошибки

### Быстрая диагностика

```bash
sudo systemctl status myapp caddy --no-pager
sudo journalctl -u myapp -n 100 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
sudo journalctl -u myapp -f
```

Из просмотра `-f` выходят через `Ctrl+C`: приложение при этом не останавливается.

```bash
sudo ss -lntp
df -h
free -h
curl --fail --show-error http://127.0.0.1:3000/health
curl --fail --show-error https://api.example.com/health
```

На другом компьютере, для схемы с закрытым backend:

```powershell
Test-NetConnection SERVER_IP -Port 443
Test-NetConnection SERVER_IP -Port 3000
Test-NetConnection SERVER_IP -Port 5432
```

Ожидается доступность 443 и недоступность внутренних 3000/5432. При публичном IPv6 проверяйте также его. Тест изнутри VPS не доказывает закрытость порта снаружи.

| Симптом | Что проверить |
|---|---|
| HTTPS не появился | A/AAAA, домен в Caddyfile, входящие 80/443, CAA, журнал Caddy |
| 502 Bad Gateway | Запуск приложения, правильный порт, локальный `/health`, Caddy upstream |
| 403 у статики | Права прохода по каталогам и чтения файлов для `caddy`; используйте `/srv`, не приватный home |
| SPA открывается, обновление `/profile` даёт 404 | Нужен корректный fallback на `index.html` |
| Вместо JSON приходит HTML | API попало в SPA-fallback; проверьте отдельный `handle` |
| API возвращает CORS-ошибку | Точный HTTPS-origin, credentials, заголовки и методы |
| Работает в SSH, не работает как служба | Абсолютный путь runtime, WorkingDirectory, env и права пользователя |
| `status=203/EXEC` | Файл команды не существует, недоступен или не исполняемый |
| Не сохраняются загрузки/кэш | Путь записи, владелец, ограничения systemd; данные должны быть вне readonly-кода |
| Нет связи с PostgreSQL | Служба БД, имя/роль/пароль, URL-encoding, `pg_hba.conf`, TLS |
| После перезапуска исчезли данные | Они лежали в release-папке или непостоянном слое контейнера |
| Старая версия интерфейса | Фактический `current`, service worker/CDN/браузерный кэш, новая ли сборка |
| `npm ci` завершился ошибкой | Совместимость Node.js, lock-файл, журнал установки, свободное место; для сборки native-зависимостей могут требоваться `build-essential` и `python3` |
| `git pull --ff-only` отказался | Локальные изменения или разошедшаяся история; разберите причину без force/reset |

Не публикуйте полные env, токены и дампы в чатах для диагностики. Логи приложения также должны скрывать пароли, cookie, заголовки Authorization и чувствительные тела запросов.

## 13. Несколько проектов и короткая памятка

Для каждого серверного проекта выделяйте пользователя, службу, каталоги, порт и БД:

| Проект | Домен | Служба / пользователь | Внутренний адрес | Код / данные |
|---|---|---|---|---|
| Сайт | `site.example.com` | Только Caddy | Нет | `/srv/mysite/releases` |
| Первый API | `api.example.com` | `myapp` | `127.0.0.1:3000` | `/srv/myapp`, `/var/lib/myapp` |
| Второй API | `other.example.com` | `otherapp` | `127.0.0.1:3001` | `/srv/otherapp`, `/var/lib/otherapp` |

Один Caddy может обслуживать несколько доменов. Добавление проекта не требует останавливать уже работающий сайт. Не используйте один служебный аккаунт и общую папку секретов для всех приложений.

Перед публикацией:

- Код собран, необходимые проверки прошли, известен коммит.
- Секреты находятся вне Git и публичной сборки.
- Приложение работает без root; зависимости устанавливаются без sudo.
- Готовы бэкап, миграции и понятный путь возврата.
- Локальный health, HTTPS и основное действие пользователя работают.
- Перезагрузка VPS не требует ручного `npm start` в терминале.
- Для проекта предусмотрены мониторинг доступности, проверка места и уведомления о сбоях бэкапа.

После изменения кода сайта: **собрать → проверить → новый каталог → переключить ссылку → проверить в браузере**.

После изменения бэкенда: **подготовить релиз → проверки/бэкап/миграции → переключить ссылку → restart → health → публичная проверка**.

Для конкретно Elonbot используйте его собственные [README](../README.md#развёртывание-и-проверки) и [инструкцию VPS](ubuntu-vps-security-ru.md): у него другой путь приложения и готовый скрипт обновления. Команды этого общего справочника не заменяют его конфигурацию автоматически.
