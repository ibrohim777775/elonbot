# Elonbot

Telegram-бот для создания объявлений и их автоматической публикации в подключённых группах.

## Требования

- Python 3.12 или новее (до 3.15);
- PostgreSQL;
- токен Telegram-бота.

## Локальный запуск

1. Создайте виртуальное окружение и активируйте его.
2. Установите проект с инструментами разработки:

   ```powershell
   pip install -e ".[dev]"
   ```

3. Скопируйте `.env.example` в `.env` и заполните обязательные значения.
4. После реализации базы данных примените миграции Alembic и запустите приложение.

## Проверки

```powershell
ruff check .
ruff format --check .
pytest
```

Техническое задание: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md).
Список подзадач: [SUBTASKS.md](SUBTASKS.md).
