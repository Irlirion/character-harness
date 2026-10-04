# Локальный клиент PrismLauncher: проверка

Дата: 2026-10-04. Проверен экземпляр `/Users/irlirion/Library/Application Support/PrismLauncher/instances/1.21.11`. Клиент не изменялся и не запускался; аккаунты, токены и история сервера не читались.

## Установленное окружение

- Minecraft 1.21.11.
- Fabric Loader 0.19.5.
- Fabric API 0.141.6+1.21.11.
- Java 21.0.7, runtime PrismLauncher.
- Simple Voice Chat 1.21.11-2.6.24.
- 19 mod jars; среди них визуальные моды, ReplayMod и IAS. Это пользовательский игровой экземпляр, не отдельный агентский runtime.
- В `voicechat-client.properties`: `disabled=true`, `microphone=fifine Microphone`. Голосовую готовность нельзя считать подтверждённой по наличию jar.

## Проверка API установленного jar

Через javap проверены интерфейсы:

- `ClientSoundEvent.getRawAudio()/setRawAudio(short[])`: возможность заменить исходящее PCM в клиентском pipeline. Требуется проверить, когда событие вызывается, как влияют mute/PTT/voice activation и можно ли инициировать передачу без физического захвата. Наличие setter не доказывает независимую отправку TTS.
- `MicrophonePacketEvent`: событие исходящих пакетов.
- `ClientReceiveSoundEvent.getId()/getRawAudio()`: доступ к входящему звуку и UUID источника. Семантику UUID, proximity/group, фильтрацию и эхо проверить в живой сцене; не объявлять UUID автоматически подтверждённой личностью.
- `VoicechatClientApi`: состояние muted/disabled/disconnected и voice group. Client audio channels воспроизводят локальный звук; их нельзя считать способом трансляции речи другим игрокам.

## Следующий эксперимент

Использовать отдельный экземпляр клиента для персонажа, содержащий Fabric/API/SVC и наш client bridge. Не переносить автоматически аккаунты, игровые миры и все визуальные моды пользователя. Bridge подключается к core на localhost через отдельный токен; исходящее аудио имеет ограниченную очередь и отмену, игровые действия выполняются в игровом потоке.

Сначала тестовая PCM-фраза через клиентский pipeline, слышимая вторым клиентом на сервере. Затем входящий звук с источником и отсутствие собственного эха. Если API pipeline требует работающего микрофонного захвата, исследовать его настройки или отдельный виртуальный audio source; не обещать отсутствие виртуального устройства заранее.

Native PrismLauncher-клиент на Mac означает Docker core/engine/голосовые сервисы + native игровой клиент. Это предложенное исключение из полного Docker-развёртывания, ещё не подтверждённое пользователем. Проверка Docker-only игрового клиента остаётся отдельной задачей.

## Loopback spike: подготовка и промежуточный результат

По разрешению пользователя создан отдельный PrismLauncher instance `character-harness-test` с названием `Character Harness Voice Test`: скопированы version metadata, выбранные Java settings, только Fabric API и SVC. Пользовательские аккаунты, миры и история не копировались. Запущен через Launch Offline как `SeverTest`; SVC native audio libraries успешно инициализировались.

Создано новое Loopback-устройство `Character Harness Voice`, источник QuickTime Player, два выходных канала, без физического микрофона. Исходные Loopback устройства и игровой instance не перенастраивались. Тестовый `work/voice-spike/test.aiff` получен штатным macOS `say`/Milena. Во время проигрывания индикаторы Loopback источника и выходных каналов показывали сигнал — участок QuickTime → виртуальное устройство проверен. Это ещё не доказывает получение сигнала SVC или слышимость на сервере.

Только в test instance установлены microphone=Character Harness Voice, microphone_activation_type=VOICE, disabled=false, muted=false, voice_activity_detection=false, voice_activation_threshold=-45.0, denoiser=false, automatic_gain_control=false. Фактическое распознавание устройства SVC проверяется после входа.

Сервер пользователь указал mc.agicraft.ru:25565. CUA видит PrismLauncher, но пока не обнаружил Java игровое окно; пользователь попросен войти вручную и подготовить второго слушателя. Регистрация/пароли остаются у пользователя. Голосовой тест через сервер ещё не завершён. QuickTime используется только для ручного transport spike, не как готовый TTS runtime харнеса.

### После входа на сервер

Пользователь сообщил о входе. Лог тестового клиента подтверждает SVC authentication acknowledged и connection check acknowledged, голосовой endpoint agicraft.ru:25577. На Mac SVC выбрал Java microphone implementation вместо OpenAL. В конфигурации сохранились Character Harness Voice, VOICE, muted=false и disabled=false.

Тестовая фраза повторно запущена через QuickTime. Подтверждение слышимости вторым игроком запрошено; оно необходимо для признания полного исходящего voice transport работающим. Подтверждённое соединение SVC не доказывает отправку PCM или слышимость.

### Результат

Пользователь подтвердил: «голос работает». Для текущего тестового окружения пройдена цепочка macOS say/Milena → test.aiff → QuickTime Player → Loopback Character Harness Voice → клиентский SVC 2.6.24 → участник сервера. Server addon не использовался. Это подтверждает ручной исходящий audio transport, но не автоматическое управление агентом, STT, отмену/дедупликацию очереди или Docker-only игровой runtime.

Следующий срез: native audio worker на Mac, который получает разрешённые задания core и воспроизводит PCM в заданное CoreAudio устройство без QuickTime UI. Сначала фиксированный тестовый файл, bounded queue, speech_id, отмена/pause и отчёт о завершении; затем TTS adapter и ответы движка. Отправка звука не означает подтверждённое восприятие каждым игроком. Клиентский bridge для игровых событий/действий и приёма речи с источниками остаётся отдельной реализацией.
