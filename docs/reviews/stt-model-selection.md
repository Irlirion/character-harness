# Локальный русский STT для Character Harness

Дата проверки: 2026-10-04. Цель: локальное распознавание коротких русских голосовых реплик (PCM16 mono, до 8 секунд) на Apple Silicon Mac с 16 GB unified memory. По выбранной архитектуре распознаватель запускается отдельным Docker HTTP service, а вход остаётся на Mac и передаётся только на `127.0.0.1`.

## Рекомендация

Для первого service-среза выбрать **`whisper.cpp` 1.9.4 + multilingual `small-q5_1`**, загрузка которой уже имеется в локальном cache. Это ограниченный deploy-now компромисс, а не утверждение, что small — лучший русский распознаватель: модель занимает около 181 MiB, рантайм — нативный C/C++ без PyTorch, upstream документирует Docker и HTTP `whisper-server`, а исходники и Whisper weights помечены MIT. `small` имеет больше параметров и занимает больше места, чем текущий `base`; это следующий размер модели в обмен на возможный выигрыш точности, который здесь подтверждён только одним синтетическим тестом. Указать `language=ru` явно, оставить сервер resident, ограничить одним одновременным запросом и нормализовать вход с 48 kHz до mono 16 kHz перед распознаванием.

На Mac для одной синтетической двухсекундной фразы («Север, повернись налево») измерено: `base` — 0,68 s, `small-q5_1` — 1,61 s; оба распознали текст точно. Образец был озвучен установленным macOS `say`/Milena, не Piper и не участником. Это проверка работоспособности/задержки на одной TTS-синтетической фразе, **не оценка точности на живой русской речи**. Нет сохранённых образцов голоса, на которых можно было бы честно выбрать STT по WER. Docker использует CPU, поэтому результат Metal на Mac не переносится на контейнер: latency и RAM Docker следует измерить во время его CPU smoke-test. Для короткой реплики дополнительная примерно секунда на native-синтетике является измеренной ценой перехода с `base` на `small`, но улучшение реального качества пока не подтверждено.

Не утверждаю, что Whisper small даст заметно меньше ошибок на реальных голосах: это нужно оценить с согласия участников на новых, необязательно сохраняемых репликах или на заранее разрешённом публичном русском наборе. Если small всё ещё ошибается на именах/игровых командах, первым challenger для bake-off взять GigaAM v2 ONNX int8. Текущий score нельзя считать самостоятельным основанием подключать команды в Minecraft: аудио-буферы сначала должны быть полностью закрыты как voice turns и ограничены allowlist действий.

## Кандидаты

| Кандидат | Русский и совместимость | Измерения на этой машине | Лицензии и решение |
|---|---|---|---|
| **whisper.cpp 1.9.4 + `small-q5_1`** | Multilingual Whisper; русскому языку задаётся `ru`. C/C++ реализация поддерживает macOS arm64, Apple Metal и Linux/Docker. `whisper-server` загружает модель в процесс и предоставляет HTTP `POST /inference`. В Docker вместо Metal работает CPU. | Модель 181 MiB (локальный файл 190,594,560 bytes). Для одной двухсекундной синтетической реплики от macOS `say`/Milena на Mac Metal: 1,61 s; transcript совпал. RAM контейнера ожидает CPU benchmark. | Upstream Whisper repo публикует код и weights под MIT. `whisper.cpp` также MIT. Выбор для немедленного bounded service; фактический transcript-quality неизвестен. Пин модели/хэша см. ниже. |
| **whisper.cpp + текущий `base`** | Multilingual и наименьшая уже доступная модель. Удобна как latency baseline; текущий worker уже работает с этой моделью. | 0,68 s на той же синтетической реплике; результат совпал. Отмеченная пользователем плохая русская расшифровка — повод сравнить следующий размер, но не даёт формального WER. | MIT код и weights. Минимальные ресурсы, но слабый кандидат на роль улучшения без сравнительных живых/public-test данных. |
| **GigaAM v2 ONNX int8 CTC (`istupakov/gigaam-v2-onnx`)** | Русский ASR, преобразован в ONNX; модельный файл около 236 MB. ONNX Runtime CPU подходит Docker. Загрузку/инференс на конкретной Mac/Docker сборке здесь не проверял. | Не загружал и не измерял. В рамках установленных ограничений не делать вывод о преимуществе качества только по русской специализации. | HF repo помечен MIT и содержит отдельный MIT LICENSE; требуется сохранить его при распространении. Лучший challenger после service smoke, если Whisper small всё ещё путает обращения/имена. Закреплённая ревизия приведена ниже. |
| **GigaAM v3 `e2e_rnnt`** | Новая русскоязычная модель с end-to-end распознаванием и нормализацией; карточка заявляет улучшение на сложных доменах и сравнение с Whisper large v3. Ветка `e2e_rnnt` — 449 MB весов, дополнительно использует custom Python/PyTorch code. На Mac с 16 GB теоретически помещается, но это уже существенно тяжелее минимального CPU microservice. | Не загружал/не измерял. | Model card помечена MIT. Хороший исследовательский challenger, но не первая реализация из-за более сложного стека, большего размера и отсутствия честного локального WER-сравнения. Не переносить лицензию между историческими GigaAM вариантами автоматически: конкретный checkpoint важен. |
| **sherpa-onnx Zipformer RU 2024-09-18** | Компактный offline ONNX путь, имеется regular и small, включая int8; sherpa-onnx документирует CPU inference, C API и сборки для нескольких архитектур. Источник модели — `alphacep/vosk-model-ru`; на карточке Vosk указан Apache-2.0 и self-reported Common Voice RU WER 6.1. Не измерял этот экспорт локально. | Не загружал/не измерял. | Engine sherpa-onnx и источник модели с permissive лицензиями — Apache-2.0; при выборе конкретного bundle сохранять его manifest/license. Альтернатива для мобильного footprint и streaming; прежде чем выбирать, нужно проверить качество именно small-версии на разрешённом русском наборе. |

GigaAM v3 по-прежнему актуальный русский challenger, а не автоматическая замена. Официальный GigaAM README сам описывает модели v1–v3 как русскоязычные; не следует путать checkpoint-лицензию с лицензией Python-кода. Отдельный sherpa bundle 2024-10-24 прямо помечен как non-commercial; его не рассматриваю в качестве рекомендуемой поставки.

## Фиксация и воспроизведение

- `whisper.cpp` checkout: tag `v1.9.4`, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a`.
- Model repo file: [`ggml-small-q5_1.bin` на commit `c521a4b02f422512d734391fdf08bb08c0862f68`](https://huggingface.co/ggerganov/whisper.cpp/blob/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small-q5_1.bin).
- SHA-256 local file и указанный HF file digest: `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`.
- Mac path: `/Users/irlirion/Library/Caches/character-harness/whisper.cpp-v1.9.4/models/ggml-small-q5_1.bin`; проектная runtime-копия уже есть в `work/stt-models/ggml-small-q5_1.bin` (ignored).
- GigaAM v2 ONNX challenger: model repo revision `3b808d182f1a2149d1fea4957ecd5a3b12068184`; selected `v2_ctc.int8.onnx`, HF reports 236 MB and SHA-256 `0f7dde6decff0160974e8783621e8ad7cf061d6ccdea8d01489767c13ab651ba`.

For Whisper’s native local one-file latency comparison on the synthetic TTS sample, use `whisper-cli -m <model> -f <16k-mono-wav> -l ru -nt`. The actual service contract receives raw little-endian signed PCM16 mono at 48 kHz with a hard 8-second limit and at most 768,000 audio bytes; the service wrapper resamples to 16 kHz. Do not infer diarization from the mixed/looped output: speaker/profile UUID should remain attached to each source PCM segment before it reaches transcription.

## Scope and quality limits

This is a model/runtime selection, not a speech quality validation. No live chat, SVC/Loopback, or retained participant audio was used in this review. The synthetic benchmark uses one short addressed command synthesized by macOS `say`/Milena; all shown accuracy evidence is therefore synthetic-only. The current Fabric PCM segmenter only begins capture after RMS crosses its threshold and trims trailing silence; losing low-energy initial consonants can produce errors independent of model size. A bounded 150–200 ms pre-roll ring buffer and a short trailing-silence allowance are appropriate capture-side changes for the implementation owner, but were not changed here.

## Primary sources

- [OpenAI Whisper README: sizes, multilingual language support, relative memory estimates, MIT license](https://github.com/openai/whisper/blob/main/README.md).
- [OpenAI Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md).
- [ggml-org whisper.cpp README: macOS arm64, Metal, Docker, build and inference](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/README.md).
- [whisper.cpp 1.9.4 Docker instructions and HTTP server example](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/README.md#docker).
- [whisper.cpp MIT license](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/LICENSE).
- [Pinned Whisper small-q5_1 file and HF license metadata](https://huggingface.co/ggerganov/whisper.cpp/blob/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small-q5_1.bin).
- [sherpa-onnx official model list](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html) and [Russian Zipformer ONNX configs](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html).
- [alphacep/vosk-model-ru model card, Apache-2.0, self-reported CV RU WER](https://huggingface.co/alphacep/vosk-model-ru).
- [GigaAM official README: Russian model families and published evaluation claims](https://github.com/salute-developers/GigaAM/blob/main/README_ru.md).
- [GigaAM v2 ONNX INT8 file, pinned source revision, size and checksum](https://huggingface.co/istupakov/gigaam-v2-onnx/blob/3b808d182f1a2149d1fea4957ecd5a3b12068184/v2_ctc.int8.onnx).
- [GigaAM v2 ONNX MIT license](https://huggingface.co/istupakov/gigaam-v2-onnx/blob/3b808d182f1a2149d1fea4957ecd5a3b12068184/LICENSE).
- [GigaAM v3 e2e_rnnt model card, Russian support, MIT, 449 MB checkpoint](https://huggingface.co/ai-sage/GigaAM-v3/tree/e2e_rnnt).
- [Legacy GigaAM 2024 sherpa model’s explicit non-commercial license notice](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html#sherpa-onnx-nemo-transducer-giga-am-russian-2024-10-24).
