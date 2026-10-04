package dev.characterharness.bridge;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class SttServiceClientTest {
    private static final String TOKEN = "synthetic-test-token-that-is-long-enough";

    @Test void postsBoundedLittleEndianPcmAndReadsTextResponse() throws Exception {
        HttpServer server = server();
        AtomicReference<byte[]> received = new AtomicReference<>();
        AtomicReference<String> authorization = new AtomicReference<>();
        server.createContext("/transcribe", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            assertEquals("application/octet-stream", exchange.getRequestHeaders().getFirst("Content-type"));
            received.set(exchange.getRequestBody().readAllBytes());
            byte[] response = "{\"text\":\"Север привет\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
            exchange.sendResponseHeaders(200, response.length);
            try (var output = exchange.getResponseBody()) { output.write(response); }
        });
        server.start();
        try {
            String text = client(server).transcribe(new short[]{(short) 0x1234, (short) -2});
            assertEquals("Север привет", text);
            assertEquals("Bearer " + TOKEN, authorization.get());
            assertArrayEquals(new byte[]{0x34,0x12,(byte)0xfe,(byte)0xff}, received.get());
        } finally { server.stop(0); }
    }

    @Test void rejectsOversizedServiceResponse() throws Exception {
        HttpServer server = server();
        server.createContext("/transcribe", exchange -> {
            byte[] response = new byte[SttServiceClient.MAX_RESPONSE_BYTES + 1];
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (var output = exchange.getResponseBody()) { output.write(response); }
        });
        server.start();
        try {
            IOException error = assertThrows(IOException.class, () -> client(server).transcribe(new short[]{1}));
            assertTrue(error.getMessage().contains("too_large") || error.getCause() != null);
        } finally { server.stop(0); }
    }

    private static HttpServer server() throws IOException {
        return HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
    }

    private static SttServiceClient client(HttpServer server) throws Exception {
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).followRedirects(HttpClient.Redirect.NEVER).build();
        return new SttServiceClient(http, base, TOKEN);
    }
}
