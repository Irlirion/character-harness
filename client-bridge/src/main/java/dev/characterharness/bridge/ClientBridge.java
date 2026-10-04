package dev.characterharness.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

public final class ClientBridge implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("CharacterHarnessBridge");
    private final Set<String> queuedReplies = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> recentlyForwarded = new ConcurrentHashMap<>();
    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "character-harness-bridge");
        thread.setDaemon(true);
        return thread;
    });
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private BridgeConfig config;
    private Pattern addressed;
    private boolean systemServerWarningLogged;

    @Override public void onInitializeClient() {
        try {
            config = BridgeConfig.load();
            addressed = ChatAddress.pattern(config.characterName());
        } catch (Exception error) {
            LOG.error("Bridge disabled: {}", error.getMessage());
            return;
        }
        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, received) -> onChat(signed, sender, received));
        if (config.systemChatEnabled()) {
            ClientReceiveMessageEvents.GAME.register((message, overlay) -> onSystemChat(message.getString(), overlay));
            LOG.info("Unverified system-chat adapter enabled for {}; it is limited to the public demo scope.", config.systemChatServer());
        }
        io.scheduleWithFixedDelay(this::pollReplies, 1, 1, TimeUnit.SECONDS);
        LOG.info("Bridge enabled for addressed chat; account UUIDs are forwarded as supplied by the server chat context. systemChatEnabled={}", config.systemChatEnabled());
    }

    private void onChat(SignedMessage signed, com.mojang.authlib.GameProfile sender, Instant received) {
        if (signed == null || signed.isSenderMissing() || sender == null) return;
        UUID profileId = sender.id();
        UUID author = signed.getSender();
        if (!author.equals(profileId)) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.player.getUuid().equals(author)) return;
        String text = ChatAddress.extract(signed.getSignedContent(), signed.filterMask(), addressed);
        if (text == null) return;
        if (text.isEmpty() || text.length() > 1000) return;
        if (!claimRecent(sender.name(), text)) return;
        try {
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
            String sourceKey = "minecraft:" + author + ":" + received.toEpochMilli() + ":" + digest;
            forwardEvent(sourceKey, author.toString(), "fabric_profile_context", null, text);
        } catch (Exception error) {
            LOG.warn("Could not forward chat event: {}", error.getClass().getSimpleName());
        }
    }

    private void onSystemChat(String visibleLine, boolean overlay) {
        if (overlay || !config.systemChatEnabled()) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || !isAllowedSystemChatServer(client.getCurrentServerEntry())) return;
        SystemChatParser.AddressedMessage parsed = SystemChatParser.parse(visibleLine, addressed);
        if (parsed == null || parsed.text().length() > 1000
                || client.player.getName().getString().equalsIgnoreCase(parsed.nickname())
                || !claimRecent(parsed.nickname(), parsed.text())) return;
        try {
            String nickname = parsed.nickname().toLowerCase(Locale.ROOT);
            String authorId = "minecraft-system:" + config.systemChatServer() + ":" + nickname;
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(parsed.text().getBytes(StandardCharsets.UTF_8)));
            String sourceKey = "minecraft-system:" + config.systemChatServer() + ":" + nickname + ":" + Instant.now().toEpochMilli() + ":" + digest;
            forwardEvent(sourceKey, authorId, "minecraft_system_chat", config.systemChatServer(), parsed.text());
        } catch (Exception error) {
            LOG.warn("Could not forward system chat event: {}", error.getClass().getSimpleName());
        }
    }

    private boolean isAllowedSystemChatServer(ServerInfo server) {
        if (server == null) return false;
        try {
            String address = BridgeConfig.normalizeSystemChatServer(server.address);
            if (config.systemChatServer().equals(address)) return true;
        } catch (Exception ignored) {
            // Treat malformed or non-target addresses identically; never include a server-provided string in logs.
        }
        if (!systemServerWarningLogged) {
            systemServerWarningLogged = true;
            LOG.warn("System-chat event ignored: connected server is not the configured test server.");
        }
        return false;
    }

    private synchronized boolean claimRecent(String nickname, String text) {
        long now = System.nanoTime();
        String key = nickname.toLowerCase(Locale.ROOT) + "\u0000" + text;
        Long previous = recentlyForwarded.get(key);
        recentlyForwarded.entrySet().removeIf(entry -> now - entry.getValue() > TimeUnit.SECONDS.toNanos(2));
        if (previous != null && now - previous <= TimeUnit.SECONDS.toNanos(2)) return false;
        recentlyForwarded.put(key, now);
        return true;
    }

    private void forwardEvent(String sourceKey, String authorId, String authorProvenance, String sourceServer, String text) {
        JsonObject body = new JsonObject();
        body.addProperty("source_key", sourceKey);
        body.addProperty("author_id", authorId);
        body.addProperty("author_provenance", authorProvenance);
        if (sourceServer != null) body.addProperty("source_server", sourceServer);
        body.addProperty("text", text);
        io.execute(() -> {
            try {
                HttpResponse<String> response = request("POST", "/bridge/events", body.toString());
                if (response.statusCode() != 200) LOG.warn("Core rejected chat event with status {}", response.statusCode());
            } catch (Exception error) {
                LOG.warn("Could not forward chat event: {}", error.getClass().getSimpleName());
            }
        });
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
                        catch (Exception error) { LOG.warn("Could not acknowledge reply: {}", error.getClass().getSimpleName()); }
                        finally { queuedReplies.remove(id); }
                    });
                });
            }
        } catch (Exception error) {
            LOG.warn("Bridge poll failed: {}", error.getClass().getSimpleName());
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
