# Codex runtime

Статус 2026-10-04: изолированный ChatGPT-вход через Codex app-server подтверждён; synthetic event прошёл реальный `gpt-6-luna` turn, сохранил ответ и завершил speech job. Live Minecraft chat ждёт перезапуска test instance с Fabric bridge.

Codex запускается в отдельном Compose service с собственными `CODEX_HOME` и постоянным volume `codex_data`. Он не копирует `~/.codex/auth.json`, не читает пользовательские настройки и не получает shell, filesystem, browser, apps или computer-use инструменты. Движок получает только MCP-функции состояния и памяти. Подписка и модель должны принадлежать пользователю, выполнившему отдельный device login.

Compose закрепляет `CODEX_MODEL=gpt-6-luna` как модель по умолчанию. Перед запуском движок сверяет её с авторизованным каталогом. Если модель отсутствует или имя задано неверно, запуск завершится ошибкой; автоматического перехода на модель по умолчанию аккаунта нет.

Первый запуск:

```sh
docker compose --profile codex run --rm codex-engine node --experimental-strip-types scripts/codex-login.ts
```

Откройте показанный verification URL, введите одноразовый код и завершите вход в браузере. Код действует ограниченное время. Он и access/refresh tokens не записываются в документацию или чат. Проверить результат входа и доступность закреплённой модели без inference:

```sh
docker compose --profile codex run --rm codex-engine node --experimental-strip-types scripts/codex-check.ts
```

Запустить движок после успешной проверки:

```sh
docker compose --profile codex up --build -d codex-engine
docker compose --profile codex logs -f codex-engine
```

Остановить инициативу через owner API или остановить Compose service. Сообщения игроков проходят через отдельный Fabric client bridge. Пока bridge не установлен в тестовом клиенте, `/owner/events` остаётся только синтетическим входом для разработки.

Результат проверки `authenticated=true` подтверждает login, но не гарантирует наличие любого имени модели. `codex-check` выводит только выбранное имя модели. Live inference проверяется отдельным синтетическим событием после явного запуска профиля.
