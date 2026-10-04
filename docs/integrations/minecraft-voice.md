# Голос в Minecraft: Simple Voice Chat

Дата: 2026-10-04. Пользователь подтвердил Simple Voice Chat и требование говорить голосом в социальном MVP. Входящее распознавание речи предложено как расширение, а не подтверждённое требование.

## Предлагаемый путь

```text
Pi/Codex -> MCP minecraft_speak -> core policy
-> TTS adapter -> audio stream -> server voice bridge
-> Simple Voice Chat -> клиенты игроков рядом с персонажем
```

Mineflayer продолжает управлять игровым персонажем. Голос передаётся отдельным bridge через серверный API Simple Voice Chat. Базовое управление Mineflayer не требует нашего плагина, но выбранный голосовой путь требует установки собственного server addon/plugin и административного доступа к серверу. Пользователь выбрал Minecraft 1.21.11 / Fabric. Java bridge реализуется как Fabric server addon; установленную версию Simple Voice Chat и совместимость нужно закрепить перед сборкой.

Simple Voice Chat API предоставляет entity/locational audio channels, AudioPlayer, Opus encoder и AudioSender для имитации отправки звука игроком без клиентского мода. Для первого spike предпочтителен entity channel, связанный с сущностью персонажа. Отображение говорящего игрока, совместимость с Mineflayer-аккаунтом, дальность и движение источника проверяются отдельно; воспроизведение канала не объявляется эквивалентом обычной микрофонной сессии.

Игрокам нужен совместимый клиент Simple Voice Chat. UDP порт голосового сервера настраивается отдельно от Minecraft TCP; по умолчанию Simple Voice Chat использует 24454/UDP. При Docker-развёртывании тестового сервера публикуется нужный UDP порт. Core не должен имитировать собственный голосовой UDP клиент, если звук отправляет серверный bridge.

## Контракт

Проектный MCP tool:

```text
minecraft_speak(text, style?) -> operation_id
operations_cancel(operation_id) -> cancellation_status
```

Голос, игровое подключение, UUID и разрешённая аудитория привязаны к персонажу сервером. Модель не выбирает произвольного игрока для подмены источника. style ограничен профилем персонажа. События: speech_started, speech_completed, speech_cancelled, speech_failed.

TTS-провайдер пока не выбран. Adapter возвращает поток PCM с явным форматом; bridge нормализует его под формат API и кодирует Opus. Аудио не передаётся base64 через контекст LLM или MCP tool arguments. Отдельный аутентифицированный канал core ↔ bridge несёт аудио и команду воспроизведения; bounded buffers, таймауты и предел длительности обязательны.

Одна активная реплика на персонажа, ограниченная очередь, дедупликация speech_id. Устаревшая реплика отменяется, а не проигрывается после reconnect. pause владельца прекращает воспроизведение. Готовность голосового адаптера отделена от подключения Minecraft; при ошибке голос явно недоступен, возможен текстовый fallback.

## Социальное качество

У персонажа устойчивый voice profile. Реплики короткие и уместные, с ограничением частоты. Громкость и дальность определяются конфигурацией voice chat; обход настроек mute игрока не является целью. Публичная речь не содержит приватной Telegram-памяти. Метрики: время до первого звука, отмена, перекрывающиеся реплики, понятность и оценка участниками ненавязчивости. Конкретные пороги выбираются по пилоту.

## Входящий голос — возможный следующий шаг

PlayerAudioListener API описывает прослушивание того аудио, которое теоретически получил бы игрок. Предложение: listener персонажа -> voice activity/utterance boundaries -> STT -> speech_received с UUID источника и audience -> обычный runtime.

Перед реализацией проверить group/proximity semantics, mute, доступность подключения бота и собственное эхо. Не перехватывать весь серверный звук ради локального разговора. Сырая запись не сохраняется по умолчанию; транскрипты наследуют источник и аудиторию. Политика обработки голоса участников и отправки провайдеру определяется до включения STT.

## Spike и критерии готовности

1. Выбрать loader и закрепить версии Minecraft, Simple Voice Chat и Java toolchain.
2. Проиграть тестовый PCM через entity channel персонажа; проверить движение и дальность двумя клиентами.
3. Подключить TTS и вызвать minecraft_speak через MCP; проверить первый звук, конец реплики и отмену.
4. Проверить reconnect, duplicate speech_id, исчезновение entity и перегрузку очереди.
5. В Docker звук работает без микрофона/динамиков хоста; серверный UDP корректно опубликован.
6. Отдельно испытать AudioSender, только если для эффекта демо нужен обычный индикатор говорящего игрока.

Источники: [Simple Voice Chat](https://github.com/henkelmax/simple-voice-chat), [Server API](https://voicechat.modrepo.de/de/maxhenkel/voicechat/api/VoicechatServerApi.html), [AudioSender](https://voicechat.modrepo.de/de/maxhenkel/voicechat/api/audiosender/AudioSender.html), [PlayerAudioListener](https://voicechat.modrepo.de/de/maxhenkel/voicechat/api/audiolistener/PlayerAudioListener.html).
