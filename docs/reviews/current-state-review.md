# Обзор текущего состояния Character Harness

Дата: 2026-11-07. Typecheck прошёл; Docker core пересобран в режиме без тестов и запущен с UnionClef Compose overlay. Owner API подтвердил прямое MCP соединение.

## Результат миграции

- Custom Fabric companion, его игровые HTTP routes и отдельный bridge token удалены из runtime и исходников.
- Core теперь получает панельное состояние и наблюдение мира read-only вызовами `tools/list` и `getGameState` через UnionClef MCP.
- UnionClef MCP отвечает; core видит 60 инструментов и `getGameState` сообщает `ready`. Панель получает это напрямую.
- Выбранный Prism instance обновлён: старый jar/config удалены в пользу UnionClef-only установки. Уже запущенный Minecraft процесс нужно перезапустить, чтобы он выгрузил ранее загруженный companion.

## Известные upstream ограничения

В закреплённой версии UnionClef v0.95.63 `getGameState` содержит состояние игрока и мира, но не адрес сервера или стабильный ID переподключения. MCP каталог также не предоставляет входящие chat/voice события с устойчивыми event IDs. Поэтому панель помечает server identity как недоступную; смена сервера из MCP заблокирована. Игровой chat ingress, STT и game voice output при удалении companion недоступны.

Изменяющие MCP-инструменты сейчас проверяют паузу/epoch и доступность игрового состояния, а повторы фиксируются durable receipt. Upstream не даёт достаточных данных для прежнего server/session fencing; его нельзя считать эквивалентно восстановленным. Для строгого fencing нужен upstream server identity + session generation API.

## Остальные работающие системы

- Core, PostgreSQL, Pi/Codex engine и owner dashboard.
- Scoped social memory и runtime activities с checkpoint/wakeup.
- Telegram Bot API: личка/группа, approvals, delivery outbox.
- Qwen TTS и native audio worker как отдельный host audio pipeline. Их heartbeat показывает доступность процессов, но не звук в Minecraft.
- Dashboard обновляется каждые пять секунд, показывает worker heartbeats и прямой UnionClef MCP status после пересборки core.

## Что мешает полной автономности

1. Нет событийного входа от игроков Minecraft; агент не просыпается на игровой чат.
2. Нет аудио API для игрового SVC/STT и ответа голосом.
3. Не хватает проверяемой server/session identity для строгого fencing действий.
4. Не проверен end-to-end цикл: несколько игроков, длительные задачи, восстановление после disconnect и социальные метрики.
5. Runtime workspace/self-improvement, review, rollout и rollback остаются roadmap работой.

## Панель и развёртывание

Панель читает только owner API и не показывает токены. Откройте `http://localhost:3000/`, введите `OWNER_TOKEN`; данные опрашиваются раз в пять секунд. Секрет UnionClef монтируется только в core через Compose secret. Engine, audio worker и TTS heartbeat сейчас `ready`; это не означает Minecraft voice output.

Тесты в этой задаче не запускались. Для этой сборки прошёл `pnpm typecheck`; Dockerfile сохраняет тесты по умолчанию и допускает явный typecheck-only режим через `RUN_TESTS=0`.

Подробные этапы: [roadmap](../roadmap.md).
