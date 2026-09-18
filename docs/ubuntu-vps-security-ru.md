Безопасная начальная настройка VPS для Elonbot

Инструкция обновлена 18 сентября 2026 года для вашей Ubuntu 24.04 и купленного домена. Сайт подключается прямо к VPS: DNS домена → Caddy с HTTPS → приложение Elonbot на порту 8000. Команды для Windows выполняются на вашем компьютере в PowerShell; команды для сервера — внутри SSH-подключения к VPS.

Заменяйте SERVER_IP на IP сервера из панели хостинга, example.com — на купленный домен, а bot.example.com — на выбранный адрес бота. Например, для домена myelon.uz можно использовать bot.myelon.uz. Во всех настройках ниже должен быть один и тот же адрес.

Шаги 1–8 защищают сервер. Шаг 9 подробно описывает установку самого бота с пустой базой, как вы выбрали: старые пользователи, объявления и Telegram-сессии не переносятся. В шагах 10–11 подключается домен и HTTPS, в шаге 12 запускается бот, в шаге 13 проверяется результат. Пароли, приватный SSH-ключ и файл .env никому не отправляйте.

**1. Узнайте версию Ubuntu и проверьте доступ**

На Windows откройте PowerShell и подключитесь с именем пользователя, выданным хостингом. Например, если выдан root:

```powershell
ssh root@SERVER_IP
```

Если хостинг указал другого пользователя или порт, используйте их: например, `ssh -p 2222 ubuntu@SERVER_IP`. При первом подключении сравните отпечаток ключа сервера с данными хостинга или его веб-консоли, если они доступны.

Внутри подключения выполните:

```bash
cat /etc/os-release
whoami
uname -m
```

В первой команде найдите PRETTY_NAME и VERSION_ID. Для вашей системы ожидается VERSION_ID="24.04". whoami показывает текущего пользователя. uname -m показывает архитектуру: x86_64 или aarch64.

Проверьте, что в панели хостинга доступна веб-консоль или режим восстановления. Включите двухфакторную защиту аккаунта хостинга и сохраните коды восстановления вне VPS.

**2. Установите обновления**

На сервере:

```bash
sudo apt update
sudo apt upgrade
sudo apt install openssh-server ufw unattended-upgrades ca-certificates curl nano
```

Если появится вопрос о замене изменённого sshd_config, пока сохраните текущую версию. Не меняйте версию Ubuntu командой do-release-upgrade в рамках этих шагов.

**3. Создайте пользователя для управления сервером**

На сервере, под исходным пользователем с правами администратора:

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
```

Придумайте отдельный надёжный пароль. Он понадобится для sudo даже после отключения входа по паролю через SSH. Поля имени и телефона можно пропустить нажатием Enter.

Если пользователь deploy уже существует, не создавайте его повторно: сначала проверьте, ваш ли это пользователь.

**4. Настройте вход по SSH-ключу**

В новом окне PowerShell на Windows:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\elonbot_vps" -C "elonbot-vps"
Get-Content "$env:USERPROFILE\.ssh\elonbot_vps.pub"
```

При генерации задайте парольную фразу для ключа. Если ssh-keygen предлагает перезаписать существующий ключ, ответьте n и используйте другое имя файла.

Последняя команда покажет публичный ключ — одну строку, начинающуюся с ssh-ed25519. Скопируйте эту строку целиком. Файл без расширения .pub — приватный ключ: он остаётся на вашем компьютере.

В старом SSH-окне на сервере:

```bash
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo nano /home/deploy/.ssh/authorized_keys
```

Вставьте публичный ключ отдельной строкой. Если в файле уже есть ключи, сохраните их. В nano: Ctrl+O → Enter для сохранения, Ctrl+X для выхода.

```bash
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Теперь в новом окне PowerShell проверьте именно вход по ключу:

```powershell
ssh -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -i "$env:USERPROFILE\.ssh\elonbot_vps" deploy@SERVER_IP
```

Если используется нестандартный SSH-порт, добавьте `-p ВАШ_ПОРТ`. Парольная фраза ключа допустима; пароль пользователя VPS для этого входа запрашиваться не должен.

В новом подключении выполните:

```bash
sudo whoami
```

Ожидаемый результат — root. Старое SSH-окно оставьте открытым. К следующему шагу переходите только после успешного входа по ключу и проверки sudo. Ubuntu описывает ключи и проверку конфигурации в [документации OpenSSH](https://ubuntu.com/server/docs/how-to/security/openssh-server/).

**5. Отключите вход root и вход по паролю через SSH**

В подключении пользователя deploy на сервере:

```bash
sudo nano /etc/ssh/sshd_config.d/00-elonbot.conf
```

Содержимое:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Проверьте синтаксис:

```bash
sudo /usr/sbin/sshd -t
```

Успех — отсутствие вывода. При ошибке сначала исправьте файл; не перезагружайте службу.

Проверьте действующие настройки:

```bash
sudo /usr/sbin/sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
```

Ожидаются соответственно no, yes, no, no. Если значения отличаются, другой файл настроек имеет приоритет: не удаляйте файлы хостинга наугад. Конфигурации с блоками Match требуют проверки для конкретного пользователя и адреса подключения.

Когда проверка успешна:

```bash
sudo systemctl reload ssh
```

Ещё раз откройте новое подключение deploy с ключом и проверьте sudo. Только после этого закрывайте старое окно. Изменения SSH проверяются до применения, как рекомендует [Ubuntu](https://ubuntu.com/server/docs/how-to/security/openssh-server/).

**6. Включите сетевой экран**

На сервере посмотрите порт текущего SSH-подключения:

```bash
echo "$SSH_CONNECTION"
```

Последнее число — порт сервера для SSH. Если строка пустая, узнайте порт в панели хостинга. Не включайте firewall, пока не знаете правильный порт.

Ниже команды для порта 22. Если у вас другой порт, замените 22 на него:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status verbose
```

Сначала разрешаются нужные соединения, затем включается фильтрация. Проверьте новый вход с компьютера, оставив текущее соединение открытым. Если у провайдера есть отдельный сетевой firewall, разрешите там фактический SSH-порт, TCP 80 и TCP 443. Порты 80 и 443 должны быть доступны посетителям сайта и проверкам центра сертификации.

Публично нужны только SSH, HTTP (80) и HTTPS (443). Caddy будет перенаправлять HTTP на HTTPS. Порты приложения 8000, PostgreSQL 5432 и управляющего API Caddy 2019 не открывайте в интернет. Для этой инструкции разрешение UDP 443 не требуется.

Если firewall уже включён, добавьте правила для 80/tcp и 443/tcp и проверьте `sudo ufw status verbose`; сбрасывать правила не нужно. Правила для IPv6 также должны действовать, если сервер имеет IPv6. Если status показывает другие разрешённые порты или широкое правило Allow, сначала выясните, какой службе оно нужно. Основа настройки — [документация UFW](https://documentation.ubuntu.com/server/how-to/security/firewalls/index.html).

**7. Включите автоматические обновления безопасности**

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Выберите Yes. Проверьте:

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
```

Ожидаются включённые ежедневные проверки и установка:

```text
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

Время от времени проверяйте, нужна ли перезагрузка:

```bash
test -f /var/run/reboot-required && cat /var/run/reboot-required
```

Перезагружайте сервер в подходящее время, после проверки входа по ключу и доступности веб-консоли: `sudo reboot`. SSH отключится; после загрузки подключитесь заново. Автоматические обновления ОС не означают автоматического обновления npm-зависимостей проекта. Настройка обновлений описана в [документации Ubuntu](https://ubuntu.com/server/docs/how-to/software/automatic-updates/).

**8. Подготовьте резервные копии**

Включите регулярные резервные копии VPS в панели хостинга, если эта функция доступна. Для работающего Elonbot дополнительно нужны копия PostgreSQL, конфигурация, исходный SESSION_ENCRYPTION_KEY, файл /etc/caddy/Caddyfile и настройки службы бота. Храните защищённую копию вне этого VPS и проверяйте восстановление в отдельную тестовую базу. Одного снимка на том же сервере недостаточно.

**9. Установите Elonbot на VPS — подробно, с пустой базой**

Здесь устанавливаются три вещи: Node.js запускает код бота, PostgreSQL хранит данные, systemd держит бот включённым после закрытия SSH и перезагрузки VPS. Сборка через npm run build не потребуется.

Команды с пометкой «На сервере» вводите в SSH-окне, где строка начинается с deploy@… . Команды «На Windows» — в отдельном окне PowerShell на компьютере. Само приглашение deploy@…:~$ копировать не нужно. Выполняйте блоки по порядку; при ошибке не переходите к следующему.

**9.1. Сначала проверьте права deploy**

На сервере:

```bash
whoami
sudo whoami
```

Первая команда должна вывести deploy, вторая — root. Для sudo вводится пароль пользователя deploy; символы пароля при вводе не отображаются.

Если снова появляется `deploy is not in the sudoers file`, вернитесь в оставленное окно root и выполните:

```bash
usermod -aG sudo deploy
```

После этого откройте новое SSH-подключение deploy и снова проверьте sudo whoami. Дальнейшие команды требуют работающего sudo.

**9.2. Установите Node.js 24**

На сервере:

```bash
sudo apt update
sudo apt install -y ca-certificates curl xz-utils openssl
```

Следующий блок скачивает Node.js 24.21.0 с официального сайта, выбирает вариант для процессора VPS и проверяет контрольную сумму архива. Это версия ветки 24 LTS из [официального каталога Node.js](https://nodejs.org/dist/latest-v24.x/) на дату инструкции. Проект допускает версии Node.js от 22 до 24 включительно.

Скопируйте блок целиком, включая круглые скобки. Он предназначен для первой установки в /opt/node24 и остановится, если этот каталог уже существует:

```bash
(
  set -euo pipefail
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) echo "Неизвестная архитектура: остановите установку"; exit 1 ;;
  esac
  if [ -e /opt/node24 ]; then
    echo "/opt/node24 уже существует. Проверьте установленную версию, не перезаписывайте её."
    exit 1
  fi
  node_release=v24.21.0
  node_archive="node-${node_release}-linux-${node_arch}.tar.xz"
  node_download_dir="$(mktemp -d)"
  cd "$node_download_dir"
  curl -fSLO "https://nodejs.org/dist/${node_release}/${node_archive}"
  curl -fSLO "https://nodejs.org/dist/${node_release}/SHASUMS256.txt"
  grep " ${node_archive}$" SHASUMS256.txt | sha256sum --check -
  sudo install -d -m 755 /opt/node24
  sudo tar -xJf "$node_archive" -C /opt/node24 --strip-components=1 --no-same-owner
)
```

Проверьте установку:

```bash
/opt/node24/bin/node --version
env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm --version
```

Ожидается v24.21.0 и номер версии npm. В этой инструкции используется полный путь /opt/node24/bin/…, поэтому отдельная команда node без пути может быть недоступна — это нормально. Node.js установлен отдельно от apt: автоматические обновления Ubuntu его не обновляют; обновления ветки 24 LTS нужно устанавливать отдельно.

**9.3. Создайте пользователя для запуска бота**

На сервере:

```bash
sudo adduser --system --group --home /var/lib/elonbot --shell /usr/sbin/nologin elonbot
sudo install -d -o elonbot -g elonbot -m 750 /opt/elonbot
sudo install -d -o elonbot -g elonbot -m 750 /var/lib/elonbot
id elonbot
```

deploy — это ваш пользователь для управления VPS. elonbot — служебный пользователь, от которого будет работать программа. Ему не нужен пароль, вход по SSH или группа sudo. /opt/elonbot — папка проекта; /var/lib/elonbot — домашняя папка служебного пользователя.

Если пользователь или папка уже существуют после предыдущей попытки, проверьте их владельца и содержимое перед продолжением. Эта инструкция рассчитана на новую установку, а не на замену работающего проекта.

**9.4. Установите PostgreSQL и создайте пустую базу**

На сервере:

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
pg_lsclusters
sudo -u postgres psql -c "SHOW listen_addresses;"
```

У кластера должен быть статус online. В обычной новой установке Ubuntu 24.04 PostgreSQL слушает localhost: база доступна приложениям на этом VPS. Порт 5432 открывать в firewall не нужно. Настройка описана в [документации Ubuntu](https://ubuntu.com/server/docs/how-to/databases/install-postgresql/).

Если listen_addresses показывает * или внешний IP, найдите файл настроек:

```bash
sudo -u postgres psql -tAc "SHOW config_file;"
```

Откройте выведенный путь через sudo nano, установите `listen_addresses = 'localhost'`, сохраните и выполните `sudo systemctl restart postgresql`. Меняйте это только для новой базы этого проекта; у уже используемой другими приложениями базы сначала нужно проверить их подключения. Не добавляйте правила с trust или доступом из 0.0.0.0/0 в pg_hba.conf.

Создайте пароль для базы:

```bash
openssl rand -hex 24
```

Сохраните полученную строку из 48 символов в менеджере паролей. Это отдельный пароль для базы, не пароль deploy. Он состоит из цифр и букв a–f, поэтому его можно безопасно вставить в строку подключения без специального кодирования.

Создайте пользователя базы:

```bash
sudo -u postgres createuser --login --pwprompt --no-superuser --no-createdb --no-createrole elonbot
```

На оба запроса пароля вставьте только что созданную строку. Затем создайте саму базу:

```bash
sudo -u postgres createdb --owner=elonbot elonbot
```

Служебный пользователь Linux и пользователь PostgreSQL здесь оба называются elonbot, но это разные учётные записи. Пользователь PostgreSQL владеет только своей базой и не является администратором всего PostgreSQL.

Проверьте подключение:

```bash
psql -h 127.0.0.1 -U elonbot -d elonbot -W -c "SELECT current_user, current_database();"
```

Введите пароль базы. В двух колонках должно быть elonbot. Если база или роль уже существуют, не удаляйте их командами DROP и не повторяйте создание вслепую. После успешной проверки создание базы повторять не нужно.

**9.5. Подключите GitHub по SSH и загрузите проект**

Ниже вариант для GitHub. Git хранит историю изменений, а GitHub — репозиторий в интернете. На компьютере вы сохраняете и отправляете изменения; VPS скачивает уже отправленные файлы.

В примерах OWNER — ваш логин или организация GitHub, elonbot — название репозитория, main — ветка проекта. Заменяйте OWNER в командах. Если репозиторий или ветка называются иначе, замените их тоже.

Порядок: Windows → GitHub → папка исходников /home/deploy/elonbot-source на VPS → рабочая папка /opt/elonbot. Бот будет запускаться из /opt/elonbot, как указано в остальных шагах инструкции.

**9.5.1. Подготовьте репозиторий на GitHub**

Если актуальная версия проекта уже есть в вашем репозитории и git push с компьютера работает, переходите к 9.5.3. Сначала убедитесь на сайте, что в выбранной ветке есть app, public, migrations, docs, package.json и package-lock.json.

При проверке этого проекта 18 сентября 2026 года удалённый репозиторий ещё не был настроен, а TypeScript-файлы находились среди несохранённых в Git изменений. Поэтому просто создать пустой репозиторий на сайте недостаточно: нужно выполнить commit и push из 9.5.2.

На сайте GitHub войдите в свой аккаунт, включите двухфакторную защиту и создайте репозиторий: кнопка + → New repository. Название — elonbot, видимость — Private. Для загрузки уже существующего локального проекта оставьте новый репозиторий пустым: без добавления README, .gitignore и лицензии через сайт. Если репозиторий уже существует, используйте его, новый создавать не нужно.

Теперь на Windows откройте обычный PowerShell:

```powershell
Set-Location "D:\work\projects\elonbot"
git --version
git status --short
git remote -v
```

Если команда git не найдена, установите [Git for Windows](https://git-scm.com/download/win) и откройте PowerShell заново. В этом проекте Git уже инициализирован; повторно выполнять git init не нужно.

Создайте на Windows отдельный SSH-ключ для GitHub:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\github_elonbot" -C "elonbot-windows"
Get-Content "$env:USERPROFILE\.ssh\github_elonbot.pub"
```

Задайте парольную фразу ключа и сохраните её. Если такой файл уже существует и ssh-keygen предлагает его перезаписать, ответьте n. Используйте существующий подходящий ключ или другое имя, заменив его во всех следующих командах. Ключ elonbot_vps из шага 4 оставьте для входа на VPS.

Скопируйте всю строку из файла github_elonbot.pub. В GitHub откройте меню аватара → Settings → SSH and GPG keys → New SSH key. Title: Elonbot Windows, Key type: Authentication Key. В Key вставьте скопированную строку и сохраните. Приватный файл github_elonbot без .pub остаётся на компьютере. [Создание SSH-ключа для GitHub](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent).

Проверьте подключение из PowerShell:

```powershell
ssh -T -o IdentitiesOnly=yes -i "$env:USERPROFILE\.ssh\github_elonbot" git@github.com
```

При первом подключении SSH покажет отпечаток сервера. Сравните его с [официальными отпечатками GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) и только при совпадении введите yes. Не отключайте проверку ключа сервера. Затем введите парольную фразу своего ключа, если она запрошена.

Успех — приветствие с вашим логином и текстом о successful authentication. Сообщение, что GitHub не предоставляет shell access, нормально: на GitHub не открывается терминал сервера. Даже успешная проверка ssh -T возвращает код 1; ориентируйтесь на приветствие. [Проверка подключения](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection).

**9.5.2. Отправьте текущий код с Windows в репозиторий**

В том же PowerShell, из папки проекта, задайте имя и email автора коммитов. Замените примеры своими значениями; email можно взять из GitHub Settings → Emails, в том числе адрес noreply:

```powershell
git config --local user.name "YOUR_NAME"
git config --local user.email "YOUR_GITHUB_EMAIL"
git config --local core.sshCommand 'C:/Windows/System32/OpenSSH/ssh.exe -i ~/.ssh/github_elonbot -o IdentitiesOnly=yes'
```

Имя и email — подпись изменений, не способ входа. Вход выполняется SSH-ключом. Последняя строка настраивает выбранный ключ только для этого локального проекта. При git push может снова запрашиваться его парольная фраза; настройка ssh-agent для этой инструкции не обязательна.

Если git remote -v ничего не показал, добавьте адрес репозитория, заменив OWNER:

```powershell
git remote add origin git@github.com:OWNER/elonbot.git
```

Если origin уже существует, проверьте его адрес. Меняйте его только если он действительно неверный, командой `git remote set-url origin git@github.com:OWNER/elonbot.git`. SSH-адрес можно скопировать на странице репозитория: Code → SSH. Слова git@ остаются как есть; OWNER — ваш логин или организация.

Проверьте, что секретный .env не отслеживается Git:

```powershell
git ls-files -- .env
git check-ignore .env
```

Первая команда не должна вывести ничего, вторая должна вывести .env. В проекте уже есть правила исключения для .env, node_modules и dist. Если .env отображается в первой команде, остановитесь перед push: .gitignore не удаляет уже сохранённые секреты из истории. Если токены раньше попали в GitHub, их нужно отозвать и заменить; одного удаления файла недостаточно.

Добавьте файлы актуального TypeScript-проекта:

```powershell
git add .gitignore README.md app public migrations docs scripts/dev.mjs package.json package-lock.json tsconfig.json
git diff --cached --stat
git diff --cached --name-only
git diff --cached --check
git diff --cached
```

Проверьте список и содержимое перед сохранением: там не должно быть .env, приватных SSH-ключей, токенов или копии базы. Команда diff может открыть просмотрщик; нажмите q для выхода. Если в список попали ранее подготовленные вами посторонние изменения, сначала разберите их. Явный список git add выше не добавляет остальные изменённые Python-файлы автоматически.

После проверки сохраните и отправьте изменения:

```powershell
git commit -m "Prepare Elonbot for VPS"
git branch --show-current
git push -u origin main
```

Текущая ветка этого проекта — main. Если команда показывает другую ветку, используйте её имя в push и в последующем clone. Если коммитов для сохранения нет, но нужная версия уже закоммичена, можно перейти к push. При rejected/non-fast-forward не используйте --force: в удалённой ветке есть история, которую сначала нужно согласовать с локальной.

После успешного push обновите страницу репозитория. Убедитесь, что видны app, public, migrations, docs, scripts/dev.mjs, package.json, package-lock.json и tsconfig.json. Только теперь эти файлы можно загрузить на VPS. Незакоммиченные или неотправленные изменения с вашего компьютера git clone не получает.

**9.5.3. Создайте на VPS ключ только для скачивания проекта**

Вернитесь в SSH-окно deploy на сервере. Установите Git:

```bash
sudo apt install -y git openssh-client
whoami
install -d -m 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -a 100 -f "$HOME/.ssh/github_elonbot_vps" -C "elonbot-vps-readonly"
cat "$HOME/.ssh/github_elonbot_vps.pub"
```

whoami должен показать deploy. Сам ключ создавайте без sudo, чтобы он принадлежал deploy. Задайте парольную фразу: она будет нужна при ручном скачивании кода. Запуск бота через systemd её не использует. При предложении перезаписать существующий ключ ответьте n и проверьте, не создавали ли его ранее.

Скопируйте показанную публичную строку. На GitHub откройте именно репозиторий elonbot → Settings → Deploy keys → Add deploy key. Title: Elonbot VPS; Key: публичная строка с VPS. Галочку Allow write access оставьте выключенной и сохраните ключ.

Так сервер получает доступ на чтение одного репозитория. Ключ компьютера добавляется в настройки аккаунта, а этот серверный ключ — в настройки репозитория. Приватные файлы между компьютером и VPS копировать не нужно. [Документация deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).

На сервере откройте настройки SSH-клиента:

```bash
nano "$HOME/.ssh/config"
```

Добавьте этот блок; если файл уже содержит другие настройки, сохраните их. Конкретный блок размещайте перед общим Host *, если такой есть:

```sshconfig
Host github-elonbot
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_elonbot_vps
    IdentitiesOnly yes
```

Сохраните Ctrl+O → Enter → Ctrl+X. Затем:

```bash
chmod 600 "$HOME/.ssh/config" "$HOME/.ssh/github_elonbot_vps"
ssh -T git@github-elonbot
```

github-elonbot — локальное имя для подключения к github.com с выбранным ключом. При первом подключении снова сравните отпечаток с официальной страницей GitHub, как в 9.5.1. Успешное приветствие для deploy key может содержать OWNER/elonbot вместо личного логина. Отсутствие shell access нормально.

Не запускайте проверку и git clone через sudo: тогда SSH будет искать настройки и ключи root. Файл authorized_keys из шага 4 менять не нужно — он отвечает за ваш вход на VPS.

**9.5.4. Скачайте проект и подготовьте файлы для запуска**

На VPS под deploy, заменив OWNER:

```bash
cd "$HOME"
git clone --branch main git@github-elonbot:OWNER/elonbot.git elonbot-source
```

Если команда завершилась успешно:

```bash
cd "$HOME/elonbot-source"
git log -1 --oneline
git status --short
ls app public migrations docs scripts/dev.mjs package.json package-lock.json tsconfig.json
```

В git log должен быть ожидаемый последний коммит, git status --short в свежей копии обычно ничего не выводит. Если папка elonbot-source уже существует, не удаляйте её и не клонируйте поверх. Сначала проверьте `git -C "$HOME/elonbot-source" remote -v` и `git -C "$HOME/elonbot-source" status --short`.

Если это ваша чистая копия нужного репозитория и выбранной ветки, получить отправленные изменения можно командой:

```bash
git -C "$HOME/elonbot-source" pull --ff-only
```

При конфликте или предупреждении о локальных изменениях остановитесь и разберите его; не применяйте reset --hard. [Описание git pull](https://git-scm.com/docs/git-pull). Эта команда обновляет только исходники в /home/deploy/elonbot-source — работающий бот в /opt/elonbot сам от неё не обновляется.

Для первой установки подготовьте архив из скачанного коммита:

```bash
git -C "$HOME/elonbot-source" archive --format=tar.gz --output="$HOME/elonbot-upload.tar.gz" HEAD app public migrations docs scripts/dev.mjs package.json package-lock.json tsconfig.json
```

Продолжайте только при успешном завершении. Архив содержит перечисленные файлы из коммита. В него не включаются каталог .git, ключи, локальный .env, node_modules и старая база. Рабочая папка программы не получит SSH-ключ deploy. [Описание git archive](https://git-scm.com/docs/git-archive).

**9.5.5. Установите скачанный проект в /opt/elonbot**

Следующие команды — только для первой установки в папку, созданную в 9.3. Если бот уже работает из /opt/elonbot, не распаковывайте файлы поверх работающего процесса: для обновления сначала нужна резервная копия базы и остановка службы.

На сервере:

```bash
sudo install -o root -g elonbot -m 640 "$HOME/elonbot-upload.tar.gz" /var/lib/elonbot/elonbot-upload.tar.gz
sudo -u elonbot tar -xzf /var/lib/elonbot/elonbot-upload.tar.gz -C /opt/elonbot --no-same-owner --no-same-permissions
sudo chmod -R o-rwx /opt/elonbot
sudo -u elonbot ls /opt/elonbot
```

В списке должны быть app, public, migrations, docs, package.json, package-lock.json, tsconfig.json и scripts. Исходники Git остаются у deploy в /home/deploy/elonbot-source, а установленная копия — у служебного пользователя elonbot в /opt/elonbot. Поэтому команды Git выполняйте в папке исходников; sudo git и изменения прав на весь проект для обхода ошибок не нужны.

Установите зависимости проекта и проверьте код одним блоком. Он сам переходит в закрытую папку /opt/elonbot от служебного пользователя:

```bash
sudo -u elonbot -H /bin/bash -c 'set -e; cd /opt/elonbot; export PATH=/opt/node24/bin:/usr/bin:/bin; npm ci --include=dev; npm run check'
```

npm ci устанавливает версии из package-lock.json, а npm run check проверяет TypeScript и не запускает бота. При успешной проверке команда завершается без ошибок. Предупреждения npm WARN отличаются от ошибки завершения npm ERR. Не запускайте npm audit fix --force автоматически: он может изменить зависимости проекта. [Документация npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

Если Git или SSH сообщает ошибку:

| Сообщение | Что проверить |
| --- | --- |
| Permission denied (publickey) | Добавлена ли публичная часть именно этого ключа; существует ли IdentityFile; выполняется ли команда от deploy без sudo. |
| Repository not found | Правильны ли OWNER и имя репозитория; добавлен ли deploy key в этот репозиторий. |
| Remote branch main not found | Отправлена ли ветка с компьютера; совпадает ли имя ветки с git branch --show-current на Windows. |
| destination path … already exists | Проверьте существующую папку и её содержимое, не удаляйте её автоматически. |
| Host key verification failed / REMOTE HOST IDENTIFICATION HAS CHANGED | Сверьте адрес и актуальные официальные отпечатки; не отключайте проверку и не очищайте known_hosts вслепую. |

После успешной установки зависимостей переходите к 9.6: .env создаётся отдельно на VPS.

**9.6. Заполните настройки .env**

Для новой пустой базы сгенерируйте новый ключ шифрования сессий:

```bash
/opt/node24/bin/node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Сохраните результат как SESSION_ENCRYPTION_KEY. Он создаётся один раз для этой базы. После появления пользователей не меняйте его при перезапуске или обновлении, иначе сохранённые Telegram-входы не расшифруются. Если когда-нибудь решите переносить старую базу, ей нужен именно её прежний ключ.

Отдельно создайте секрет webhook:

```bash
openssl rand -hex 32
```

Сохраните эту вторую строку как WEBHOOK_SECRET. Не путайте её с ключом сессий или паролем PostgreSQL.

Создайте закрытый файл настроек и откройте его:

```bash
sudo -u elonbot sh -c 'umask 077; set -C; : > /opt/elonbot/.env'
sudo nano /opt/elonbot/.env
```

Первая команда предназначена для первого создания и откажется перезаписывать существующий файл. Если .env уже был создан вами, откройте его второй командой и проверьте содержимое.

Вставьте следующий текст, заменив все значения с ВСТАВЬТЕ и адрес bot.example.com:

```dotenv
BOT_TOKEN=ВСТАВЬТЕ_ТОКЕН_ВАШЕГО_БОТА
TELEGRAM_API_ID=ВСТАВЬТЕ_API_ID
TELEGRAM_API_HASH=ВСТАВЬТЕ_API_HASH
SESSION_ENCRYPTION_KEY=ВСТАВЬТЕ_НОВЫЙ_КЛЮЧ_СЕССИЙ
WEBHOOK_BASE_URL=https://bot.example.com
WEBHOOK_SECRET=ВСТАВЬТЕ_НОВЫЙ_СЕКРЕТ_WEBHOOK

DATABASE_URL=postgresql://elonbot:ВСТАВЬТЕ_ПАРОЛЬ_БАЗЫ@127.0.0.1:5432/elonbot
DATABASE_SSL=false
ADMIN_IDS=ВСТАВЬТЕ_ВАШ_ЧИСЛОВОЙ_TELEGRAM_ID

MAX_MESSAGES_PER_MINUTE=20
MAX_MESSAGES_PER_CHAT_PER_MINUTE=1
MAX_ACTIVE_ANNOUNCEMENTS_PER_USER=10
MAX_GROUPS_PER_USER=20
MAX_DELIVERIES_PER_USER_PER_DAY=500

APP_ENV=production
PORT=8000
```

Откуда взять значения:

| Настройка | Что вставлять |
| --- | --- |
| BOT_TOKEN | Токен уже существующего бота из вашего локального .env или BotFather. Создавать другого бота для VPS не нужно. |
| TELEGRAM_API_ID и TELEGRAM_API_HASH | Значения из локального .env, с которыми бот уже работает; это данные Telegram API, не токен BotFather. |
| SESSION_ENCRYPTION_KEY | Первый результат генерации из этого подпункта. Готовый ключ из .env.example не используйте. |
| WEBHOOK_SECRET | Второй результат генерации из этого подпункта. |
| DATABASE_URL | Вставьте пароль из 9.4 вместо ВСТАВЬТЕ_ПАРОЛЬ_БАЗЫ. Вся строка должна остаться на одной строке файла. |
| ADMIN_IDS | Ваш числовой ID из прежнего .env. Это не @username и не номер телефона. Несколько ID разделяются запятой. |
| WEBHOOK_BASE_URL | Ваш HTTPS-адрес, например https://bot.myelon.uz, без /app, /admin и :8000. |

Если числовой ID пока неизвестен, временно оставьте `ADMIN_IDS=` пустым. Бот запустится, но админка будет недоступна. После запуска отправьте ему /start и получите свой ID из базы командой из шага 12; затем заполните ADMIN_IDS и перезапустите службу.

Сохраните файл: Ctrl+O → Enter → Ctrl+X. Затем:

```bash
sudo chown elonbot:elonbot /opt/elonbot/.env
sudo chmod 600 /opt/elonbot/.env
sudo stat -c '%a %U:%G %n' /opt/elonbot/.env
```

Ожидается `600 elonbot:elonbot /opt/elonbot/.env`. Для чтения файла пользователем deploy понадобится sudo. Не присылайте содержимое файла в переписку. DATABASE_SSL=false здесь используется только для подключения к PostgreSQL на том же сервере через 127.0.0.1; HTTPS сайта от этого не отключается.

**9.7. Проверьте настройки и создайте таблицы**

На сервере выполните целиком:

```bash
sudo -u elonbot -H /bin/bash -c 'set -e; cd /opt/elonbot; export PATH=/opt/node24/bin:/usr/bin:/bin; npm run migrate'
```

Ожидается `Migration complete`. Команда читает .env, подключается к PostgreSQL и создаёт таблицы проекта. Она не запускает отправку объявлений и не переключает webhook. Миграции также проверяются автоматически при обычном запуске бота; создавать таблицы вручную не нужно.

При Missing … или Invalid … исправьте соответствующую строку .env. При ошибке соединения с базой повторите проверку psql из 9.4 и проверьте DATABASE_URL. Для проверки PostgreSQL используйте пароль базы, а не пароль deploy.

**9.8. Создайте службу, которая будет держать бот включённым**

На сервере:

```bash
sudo nano /etc/systemd/system/elonbot.service
```

Вставьте целиком:

```ini
[Unit]
Description=Elonbot Telegram service
Wants=network-online.target
After=network-online.target postgresql.service

[Service]
Type=simple
User=elonbot
Group=elonbot
WorkingDirectory=/opt/elonbot
Environment=NODE_ENV=production
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node24/bin/node --import tsx app/main.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=elonbot
StateDirectoryMode=0750

[Install]
WantedBy=multi-user.target
```

Сохраните файл и зарегистрируйте службу:

```bash
sudo systemd-analyze verify /etc/systemd/system/elonbot.service
sudo systemctl daemon-reload
```

Первую команду нужно выполнить успешно до второй. Пока не запускайте и не включайте автозапуск службы: сначала настройте домен и Caddy в шагах 10–11. Запуск будет в шаге 12.

WorkingDirectory указывает папку, из которой программа найдёт .env, migrations, public и docs. ExecStart запускает TypeScript напрямую через установленный tsx: npm run build не нужен. В службе не записываются секреты — приложение само читает закрытый .env. Настройки ProtectSystem и ProtectHome ограничивают запись программы в системные каталоги; домашняя папка службы и её временные файлы остаются доступны.

**9.9. Что должно получиться перед настройкой домена**

- Node.js установлен в /opt/node24.
- Код бота лежит в /opt/elonbot; зависимости установлены, проверка TypeScript прошла.
- В PostgreSQL создана новая база elonbot с собственным пользователем и таблицами.
- .env заполнен и имеет права 600.
- Служба elonbot.service создана; запуск ещё впереди.

Текущая версия приложения слушает 0.0.0.0:8000. Закрывайте внешний доступ к 8000 через UFW и firewall провайдера; Caddy будет обращаться к нему локально по 127.0.0.1. Переменная HOST в коде не предусмотрена, поэтому запись HOST=127.0.0.1 в .env адрес прослушивания не изменит. Порт PostgreSQL 5432 тоже остаётся закрытым снаружи.

Теперь переходите к шагу 10. Бот на вашем компьютере пока может работать; перед первым запуском VPS его нужно будет остановить, как описано в шаге 12.

**10. Привяжите домен к IP сервера**

Откройте управление DNS у провайдера, чьи NS-серверы сейчас указаны для вашего домена. Обычно это регистратор домена, если вы ещё не меняли NS. Создайте запись:

| Поле | Значение |
| --- | --- |
| Тип | A |
| Имя / Host | bot |
| Значение / Address | публичный IPv4 вашего VPS |
| TTL | Auto или 300 |

Получится адрес bot.example.com. Для использования самого example.com вместо поддомена обычно указывают имя @. Для одного адреса выберите один вариант и используйте его дальше везде. Запись A должна вести прямо на VPS; если у DNS-провайдера есть режим проксирования, для этой схемы используйте режим только DNS.

Не добавляйте AAAA, если IPv6 на VPS не настроен. Если для выбранного адреса уже есть AAAA, проверьте, что она указывает на работающий IPv6 именно этого VPS. Удалять MX и другие записи, относящиеся к почте или другим сайтам, не нужно. Включите двухфакторную защиту аккаунта регистратора и автопродление домена.

Проверьте DNS на своём компьютере в PowerShell:

```powershell
Resolve-DnsName bot.example.com -Type A
```

В ответе должен появиться IPv4 вашего VPS. Изменения DNS могут применяться не сразу; продолжайте настройку сертификата после появления правильного адреса.

**11. Установите Caddy и включите HTTPS**

Caddy принимает запросы к домену, получает и продлевает сертификат, затем передаёт запросы приложению. Установка из официального репозитория также создаёт службу systemd. Ниже команды для новой установки по [инструкции Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/elonbot-caddy-key.asc
sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/elonbot-caddy-key.asc
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /tmp/elonbot-caddy-stable.list
sudo install -m 644 /tmp/elonbot-caddy-stable.list /etc/apt/sources.list.d/caddy-stable.list
sudo chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo apt update
sudo apt install caddy
```

Выполняйте команды по очереди. Если загрузка ключа или списка репозиториев закончилась ошибкой, сначала устраните её. Для уже установленного Caddy повторно добавлять репозиторий не требуется.

Откройте конфигурацию:

```bash
sudo nano /etc/caddy/Caddyfile
```

На новом сервере замените стандартный пример следующим содержимым, подставив свой адрес:

```caddyfile
bot.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Если Caddy уже обслуживает другие сайты, сохраните их блоки и добавьте новый блок отдельно. Для Elonbot нужен только reverse_proxy: каталог проекта и файл .env не должны раздаваться как статические файлы. Путь запроса, включая /webhook/…, передаётся приложению без изменений. Это стандартное поведение [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Проверьте конфигурацию перед применением:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Только при успешной проверке:

```bash
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Для выпуска и продления сертификата DNS должен вести на этот VPS, TCP 80 и 443 должны быть доступны снаружи, а Caddy — постоянно работать. Если эти порты уже заняты, выясните, какой веб-сервер их использует: не останавливайте его наугад. Caddy самостоятельно включает HTTPS и перенаправление с HTTP; отдельный запуск Certbot для этой схемы не нужен. Условия описаны в [документации автоматического HTTPS](https://caddyserver.com/docs/automatic-https).

Если приложение ещё не запущено, по HTTPS может возвращаться 502 Bad Gateway. Это означает, что прокси пока не получил ответ от приложения; состояние сертификата проверяется отдельно.

**12. Проверьте домен и запустите бота**

После шагов 9–11 проверьте адрес в .env на сервере:

```bash
sudo nano /opt/elonbot/.env
```

Измените только нужные строки, сохранив остальные секреты и настройки:

```dotenv
APP_ENV=production
PORT=8000
WEBHOOK_BASE_URL=https://bot.example.com
```

В WEBHOOK_BASE_URL указывается только HTTPS-адрес без завершающего /, без :8000, без /app или /admin. Он должен совпадать с именем в Caddyfile. Ключ SESSION_ENCRYPTION_KEY, созданный в 9.6, оставьте прежним.

Перед запуском VPS остановите старый процесс этого же бота на компьютере или другом сервере. Если он работает у вас в терминале через npm run dev или npm start, нажмите Ctrl+C в том терминале и дождитесь остановки. Если он запущен службой на старом сервере, остановите именно эту службу. Старую базу удалять не нужно.

Это обязательно и при пустой новой базе: старый экземпляр может продолжать отправлять объявления и при перезапуске менять webhook. Пока пользуетесь VPS, не запускайте локальный экземпляр с тем же BOT_TOKEN.

Для первого запуска на VPS:

```bash
sudo systemctl enable --now elonbot
sudo systemctl status elonbot --no-pager
sudo journalctl -u elonbot -n 80 --no-pager
```

Статус должен быть active (running), а в журнале после миграций и подключения к Telegram появится строка [ready]. Включённая служба запускается при загрузке VPS. Соединение SSH после этого можно закрыть.

Если получите Unit elonbot.service not found, проверьте имя файла из 9.8 и выполните sudo systemctl daemon-reload. Установка Caddy сама по себе не создаёт службу бота.

Чтобы видеть новые логи и ошибки прямо в терминале:

```bash
sudo journalctl -u elonbot -n 100 -f
```

Ctrl+C завершит только просмотр журнала; бот продолжит работать. Если служба постоянно перезапускается, остановите её командой `sudo systemctl stop elonbot`, исправьте ошибку из журнала и запустите `sudo systemctl start elonbot`.

После изменения .env или кода применяйте изменения так:

```bash
sudo systemctl restart elonbot
sudo systemctl status elonbot --no-pager
sudo journalctl -u elonbot -n 80 --no-pager
```

Сборка перед этим не требуется. Изменения .env и TypeScript применяются после перезапуска, без наблюдателя npm run dev. Для обычного управления: `sudo systemctl stop elonbot` останавливает бот, `sudo systemctl start elonbot` запускает его.

При запуске приложение автоматически обновляет webhook и кнопку Mini App под WEBHOOK_BASE_URL. Отправьте боту /start и заново подключите свой Telegram-аккаунт и группы: новая база пуста. Старые сообщения чата с ботом останутся в Telegram, но объявления и настройки из старой базы на VPS не появятся.

Если оставляли ADMIN_IDS пустым, после /start выполните на VPS:

```bash
sudo -u postgres psql -d elonbot -c "SELECT telegram_id, username, first_name FROM users ORDER BY created_at DESC LIMIT 20;"
```

Найдите свою строку по username и имени и возьмите значение telegram_id. Не выбирайте чужой ID; если по этим полям нельзя однозначно определить себя, сначала уточните свой ID. Вставьте его в ADMIN_IDS файла /opt/elonbot/.env и выполните sudo systemctl restart elonbot. После этого отправьте /admin.

Чтобы получить свежие ссылки, используйте /start и /admin. Старые сообщения могут содержать ссылки на прежний адрес. Проверки доступа и HTTPS приведены в шаге 13.

**13. Проверьте сайт и доступ к сервисам**

После запуска бота на сервере:

```bash
curl --fail --show-error https://bot.example.com/health
curl --fail --show-error http://127.0.0.1:8000/health
```

Оба запроса должны вернуть `{"status":"ok"}`. Не добавляйте -k к curl: проверка должна проходить с действительным сертификатом.

На Windows, вне VPS:

```powershell
Test-NetConnection bot.example.com -Port 443
Test-NetConnection SERVER_IP -Port 8000
Test-NetConnection SERVER_IP -Port 5432
```

Для 443 ожидается TcpTestSucceeded: True, для 8000 и 5432 — False. При наличии публичного IPv6 проверьте закрытые порты и по этому адресу. Затем откройте бота: проверьте /start, добавление групп через Mini App и /admin → «Открыть в браузере».

Если сайт недоступен, проверяйте последовательно DNS, firewall провайдера, UFW, Caddy и приложение. Полезные команды на сервере:

```bash
sudo ufw status verbose
sudo ss -lntp
sudo journalctl -u caddy -n 80 --no-pager
sudo journalctl -u elonbot -n 80 --no-pager
```

При ошибке сертификата проверьте A/AAAA, доступность 80/443 и ограничения CAA, если такие записи у домена заданы. При 502 проверьте состояние бота и локальный /health. Ошибка INVALID_ORIGIN в админке обычно означает несовпадение открытого адреса и WEBHOOK_BASE_URL.

Не закрывайте весь сайт дополнительным экраном входа или CAPTCHA: Telegram должен обращаться к webhook. Для админки уже реализованы проверка ADMIN_IDS, подписанный вход из Telegram и одноразовые ссылки для браузера.
