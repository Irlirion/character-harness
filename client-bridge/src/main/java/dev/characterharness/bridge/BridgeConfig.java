package dev.characterharness.bridge;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

record BridgeConfig(String coreUrl, String token, String characterName, boolean systemChatEnabled, String systemChatServer) {
    static final String SYSTEM_CHAT_SERVER = "mc.agicraft.ru:25565";

    static BridgeConfig load() throws IOException {
        Path path = FabricLoader.getInstance().getConfigDir().resolve("character-harness-bridge.properties");
        if (Files.notExists(path)) {
            Files.createDirectories(path.getParent());
            Files.writeString(path, "core_url=http://127.0.0.1:3000\ncharacter_name=Лада\ntoken_file=\nsystem_chat_enabled=false\nsystem_chat_server=mc.agicraft.ru:25565\n");
        }
        Properties properties = new Properties();
        try (var reader = Files.newBufferedReader(path)) { properties.load(reader); }
        String coreUrl = normalizeCoreUrl(properties.getProperty("core_url", "http://127.0.0.1:3000").trim());
        String tokenPath = properties.getProperty("token_file", "").trim();
        if (tokenPath.isEmpty()) throw new IOException("Set token_file in config/character-harness-bridge.properties");
        Path file = Path.of(tokenPath).toAbsolutePath().normalize();
        String token = Files.readString(file).trim();
        if (token.length() < 32) throw new IOException("Bridge token file is invalid");
        String characterName = properties.getProperty("character_name", "Лада").trim();
        if (characterName.isEmpty() || characterName.length() > 32) throw new IOException("character_name is invalid");
        String enabledValue = properties.getProperty("system_chat_enabled", "false").trim();
        if (!enabledValue.equalsIgnoreCase("true") && !enabledValue.equalsIgnoreCase("false")) throw new IOException("system_chat_enabled must be true or false");
        boolean systemChatEnabled = Boolean.parseBoolean(enabledValue);
        String systemChatServer = normalizeSystemChatServer(properties.getProperty("system_chat_server", SYSTEM_CHAT_SERVER).trim());
        return new BridgeConfig(coreUrl, token, characterName, systemChatEnabled, systemChatServer);
    }

    static String normalizeCoreUrl(String value) throws IOException {
        final URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException error) {
            throw new IOException("core_url must be a valid loopback HTTP URL", error);
        }
        String host = uri.getHost();
        int port = uri.getPort();
        String path = uri.getRawPath();
        if (!"http".equalsIgnoreCase(uri.getScheme())
                || !isLoopbackHost(host)
                || uri.getRawUserInfo() != null
                || port < 1 || port > 65535
                || uri.getRawQuery() != null
                || uri.getRawFragment() != null
                || !(path == null || path.isEmpty() || "/".equals(path))) {
            throw new IOException("core_url must be loopback HTTP with a valid port and no credentials, path, query, or fragment");
        }
        return "http://" + host.toLowerCase(java.util.Locale.ROOT) + ":" + port;
    }

    private static boolean isLoopbackHost(String host) {
        return host != null && ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host));
    }

    static String normalizeSystemChatServer(String value) throws IOException {
        try {
            URI uri = new URI("minecraft://" + value);
            int port = uri.getPort();
            if (uri.getRawUserInfo() != null || uri.getHost() == null
                    || !"mc.agicraft.ru".equalsIgnoreCase(uri.getHost())
                    || (port != -1 && port != 25565)
                    || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IOException("system_chat_server must be mc.agicraft.ru:25565");
            }
            return SYSTEM_CHAT_SERVER;
        } catch (URISyntaxException error) {
            throw new IOException("system_chat_server must be mc.agicraft.ru:25565", error);
        }
    }
}
