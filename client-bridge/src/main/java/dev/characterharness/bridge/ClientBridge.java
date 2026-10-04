package dev.characterharness.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ClientBridge implements ClientModInitializer {
    private static final System.Logger LOG = System.getLogger("CharacterHarnessBridge");
    private final Set<String> queuedReplies = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "character-harness-bridge");
        thread.setDaemon(true);
        return thread;
    });
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private BridgeConfig config;
    private Pattern addressed;

    @Override public void onInitializeClient() {
        try {
            config = BridgeConfig.load();
            addressed = Pattern.compile("^\\s*(?:@" + Pattern.quote(config.characterName()) + "\\b\\s*[:,]?\\s*|"
                    + Pattern.quote(config.characterName()) + "\\s*[:,]\\s*)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
        } catch (Exception error) {
            LOG.log(System.Logger.Level.ERROR, "Bridge disabled: {0}", error.getMessage());
            return;
        }
        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, received) -> onChat(message.getString(), signed, sender == null ? null : sender.id(), received));
        io.scheduleWithFixedDelay(this::pollReplies, 1, 1, TimeUnit.SECONDS);
        LOG.log(System.Logger.Level.INFO, "Bridge enabled for addressed chat; account UUIDs are forwarded as supplied by the server chat context.");
    }

    private void onChat(String original, SignedMessage signed, UUID profileId, Instant received) {
        if (signed == null || signed.isSenderMissing() || profileId == null) return;
        UUID author = signed.getSender();
        if (!author.equals(profileId)) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.player.getUuid().equals(author)) return;
        Matcher matcher = addressed.matcher(original);
        if (!matcher.find()) return;
        String text = original.substring(matcher.end()).trim();
        if (text.isEmpty() || text.length() > 1000) return;
        try {
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
            String sourceKey = "minecraft:" + author + ":" + received.toEpochMilli() + ":" + digest;
            JsonObject body = new JsonObject();
            body.addProperty("source_key", sourceKey);
            body.addProperty("author_id", author.toString());
            body.addProperty("text", text);
            io.execute(() -> {
                try {
                    HttpResponse<String> response = request("POST", "/bridge/events", body.toString());
                    if (response.statusCode() != 200) LOG.log(System.Logger.Level.WARNING, "Core rejected chat event with status {0}", response.statusCode());
                } catch (Exception error) {
                    LOG.log(System.Logger.Level.WARNING, "Could not forward chat event: {0}", error.getClass().getSimpleName());
                }
            });
        } catch (Exception error) {
            LOG.log(System.Logger.Level.WARNING, "Could not forward chat event: {0}", error.getClass().getSimpleName());
        }
    }

    private void pollReplies() {
        try {
            HttpResponse<String> response = request("GET", "/bridge/replies", null);
            if (response.statusCode() != 200) return;
            JsonArray replies = JsonParser.parseString(response.body()).getAsJsonArray();
            for (int i = 0; i < replies.size(); i++) {
                JsonObject reply = replies.get(i).getAsJsonObject();
                String id = reply.get("id").getAsString();
                String text = reply.get("text").getAsString();
                if (text.isBlank() || text.length() > 300 || !queuedReplies.add(id)) continue;
                MinecraftClient.getInstance().execute(() -> {
                    MinecraftClient client = MinecraftClient.getInstance();
                    if (client.player == null) { queuedReplies.remove(id); return; }
                    client.player.sendMessage(Text.literal("[" + config.characterName() + "] ").formatted(Formatting.AQUA)
                            .append(Text.literal(text).formatted(Formatting.WHITE)), false);
                    io.execute(() -> {
                        try {
                            HttpResponse<String> ack = request("POST", "/bridge/replies/" + id + "/ack", "{}");
                            if (ack.statusCode() != 200) throw new IllegalStateException("ack_status_" + ack.statusCode());
                        }
                        catch (Exception error) { LOG.log(System.Logger.Level.WARNING, "Could not acknowledge reply: {0}", error.getClass().getSimpleName()); }
                        finally { queuedReplies.remove(id); }
                    });
                });
            }
        } catch (Exception error) {
            LOG.log(System.Logger.Level.WARNING, "Bridge poll failed: {0}", error.getClass().getSimpleName());
        }
    }

    private HttpResponse<String> request(String method, String path, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(config.coreUrl() + path))
                .timeout(Duration.ofSeconds(5)).header("Authorization", "Bearer " + config.token())
                .header("Content-Type", "application/json");
        if ("GET".equals(method)) builder.GET(); else builder.POST(HttpRequest.BodyPublishers.ofString(body == null ? "{}" : body));
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
}
