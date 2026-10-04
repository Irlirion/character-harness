package dev.characterharness.bridge;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

final class LocalWhisper {
    private final String ffmpeg;
    private final String whisper;
    private final String model;

    LocalWhisper(BridgeConfig config) {
        ffmpeg = config.ffmpegPath(); whisper = config.whisperCliPath(); model = config.whisperModelPath();
    }

    String transcribe(short[] pcm48k) throws IOException, InterruptedException {
        if (pcm48k.length == 0 || pcm48k.length > PcmSegmenter.MAX_SAMPLES) throw new IOException("audio_bounds");
        Path raw = Files.createTempFile("character-harness-voice-", ".pcm");
        Path wav = Files.createTempFile("character-harness-voice-", ".wav");
        Path prefix = Files.createTempDirectory("character-harness-whisper-").resolve("transcript");
        Path transcript = Path.of(prefix + ".txt");
        try {
            ByteBuffer bytes = ByteBuffer.allocate(pcm48k.length * 2).order(ByteOrder.LITTLE_ENDIAN);
            for (short value : pcm48k) bytes.putShort(value);
            Files.write(raw, bytes.array());
            run(new ProcessBuilder(ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", raw.toString(), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav.toString()).redirectError(ProcessBuilder.Redirect.DISCARD).redirectOutput(ProcessBuilder.Redirect.DISCARD), 8);
            run(new ProcessBuilder(whisper, "-m", model, "-f", wav.toString(), "-l", "ru", "-nt", "-otxt", "-of", prefix.toString()).redirectError(ProcessBuilder.Redirect.DISCARD).redirectOutput(ProcessBuilder.Redirect.DISCARD), 15);
            if (!Files.isRegularFile(transcript) || Files.size(transcript) > 4096) throw new IOException("transcript_missing_or_oversized");
            return Files.readString(transcript).strip();
        } finally {
            delete(raw); delete(wav); delete(transcript); delete(prefix.getParent());
        }
    }

    private static void run(ProcessBuilder builder, int seconds) throws IOException, InterruptedException {
        Process process = builder.start();
        try {
            if (!process.waitFor(seconds, TimeUnit.SECONDS)) {
                stop(process); throw new IOException("local_transcriber_timeout");
            }
        } catch (InterruptedException interrupted) {
            stop(process);
            Thread.currentThread().interrupt();
            throw interrupted;
        }
        if (process.exitValue() != 0) throw new IOException("local_transcriber_failed");
    }

    private static void stop(Process process) {
        process.destroy();
        try {
            if (!process.waitFor(500,TimeUnit.MILLISECONDS)) {
                process.destroyForcibly(); process.waitFor(500,TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException e) { process.destroyForcibly(); Thread.currentThread().interrupt(); }
    }

    private static void delete(Path path) {
        try { Files.deleteIfExists(path); } catch (IOException ignored) { path.toFile().deleteOnExit(); }
    }
}
