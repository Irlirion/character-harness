# План интеграции Telegram Bot API с main

Дата: 2026-10-17. Основание: [SDD-спецификация](../specs/2026-10-17-telegram-mvp.md).

1. Перенести проверенный Telegram MVP на main после PR #29–31, сохранив Minecraft voice/chat и социальную память.
2. Добавить миграцию 010 с Telegram provenance, bindings, polling offset, локальной историей и outbox; сохранить совместимость раннего Telegram-прототипа.
3. Связать active turn с audience события во входном контексте, MCP и памяти. Фильтровать игровые инструменты в Telegram turn.
4. Сохранять staged social memory транзакционно при reply/silence Telegram; сохранить существующий turn_finish Minecraft.
5. Проверить полную Node suite с PostgreSQL, Docker build, конфигурацию Compose и CI PR.

Проверенный до интеграции прототип отвечал в личке и группе, включая второго
участника. Ошибка формата final answer исправлена через outputSchema и поддержку
silence/text=null. Две работающие базы не объединяются автоматически: PR объединяет
код, а перенос рабочих данных и переключение запуска — отдельный шаг эксплуатации.

Результаты итоговой проверки записываются в PR.
