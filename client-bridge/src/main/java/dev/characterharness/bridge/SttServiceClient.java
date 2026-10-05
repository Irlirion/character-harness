package dev.characterharness.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.util.Objects;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

final class SttServiceClient {
    static final int MAX_REQUEST_BYTES = PcmSegmenter.MAX_SAMPLES * Short.BYTES;
    // Mirrors the service's MIN_AUDIO_BYTES: 1440 samples at 48 kHz, clear of the GigaAM v3 analysis
    // window. PcmSegmenter produces segments shorter than this whenever a speaker's utterance starts
    // with the empty pre-roll left by the previous finish, so the floor is checked here to fail
    // locally with a clear error instead of costing a round trip to be rejected with 400.
    static final int MIN_REQUEST_BYTES = 2_880;
    static final int MAX_RESPONSE_BYTES = 4096;
    private final HttpClient http;
    private final URI endpoint;
    private final String token;

    SttServiceClient(HttpClient http, String baseUrl, String token) throws IOException {
        this.http = Objects.requireNonNull(http);
        this.endpoint = URI.create(BridgeConfig.normalizeSttUrl(Objects.requireNonNull(baseUrl)) + "/transcribe");
        this.token = Objects.requireNonNull(token);
        if (token.length() < 32) throw new IllegalArgumentException("invalid_stt_token");
    }

    String transcribe(short[] samples) throws IOException, InterruptedException {
        if (samples == null || samples.length == 0 || samples.length > PcmSegmenter.MAX_SAMPLES) {
            throw new IOException("audio_bounds");
        }
        // A distinct token, not audio_bounds: this is the service's own vocabulary, so a local
        // rejection and the 400 it would have become name the same condition. audio_bounds stays the
        // caller-contract violation (null, empty, past the segmenter cap), which shares nothing with a
        // short-but-well-formed segment.
        if (samples.length * Short.BYTES < MIN_REQUEST_BYTES) {
            throw new IOException("audio_too_short");
        }
        byte[] pcm = toLittleEndian(samples);
        try {
            HttpRequest request = HttpRequest.newBuilder(endpoint)
                    .timeout(Duration.ofSeconds(20))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/octet-stream")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(pcm))
                    .build();
            HttpResponse<byte[]> response = http.send(request, info -> new LimitedBodySubscriber(MAX_RESPONSE_BYTES));
            if (response.statusCode() != 200) throw new IOException("stt_service_http_" + response.statusCode());
            String contentType = response.headers().firstValue("content-type").orElse("");
            if (!contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) {
                throw new IOException("stt_service_bad_content_type");
            }
            try {
                JsonObject json = JsonParser.parseString(new String(response.body(), java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
                if (!json.has("text") || !json.get("text").isJsonPrimitive() || !json.getAsJsonPrimitive("text").isString()) {
                    throw new IOException("stt_service_bad_response");
                }
                String text = json.get("text").getAsString();
                if (text.length() > MAX_RESPONSE_BYTES) throw new IOException("stt_service_response_too_large");
                return text;
            } catch (IllegalStateException | com.google.gson.JsonParseException error) {
                throw new IOException("stt_service_bad_response", error);
            }
        } finally {
            java.util.Arrays.fill(pcm, (byte) 0);
        }
    }

    private static byte[] toLittleEndian(short[] samples) {
        ByteBuffer buffer = ByteBuffer.allocate(samples.length * Short.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (short sample : samples) buffer.putShort(sample);
        return buffer.array();
    }

    private static final class LimitedBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {
        private final int limit;
        private final ByteArrayOutputStream output;
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private Flow.Subscription subscription;
        private int size;

        private LimitedBodySubscriber(int limit) {
            this.limit = limit;
            this.output = new ByteArrayOutputStream(Math.min(limit, 1024));
        }

        @Override public CompletionStage<byte[]> getBody() { return body; }

        @Override public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(1);
        }

        @Override public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                int remaining = buffer.remaining();
                if (size + remaining > limit) {
                    subscription.cancel();
                    body.completeExceptionally(new IOException("stt_service_response_too_large"));
                    return;
                }
                byte[] chunk = new byte[remaining];
                buffer.get(chunk);
                output.write(chunk, 0, chunk.length);
                java.util.Arrays.fill(chunk, (byte) 0);
                size += remaining;
            }
            subscription.request(1);
        }

        @Override public void onError(Throwable error) { body.completeExceptionally(error); }
        @Override public void onComplete() { body.complete(output.toByteArray()); }
    }
}
