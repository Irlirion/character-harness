package dev.characterharness.bridge;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

record BridgeConfig(String coreUrl, String token, String characterName, boolean systemChatEnabled, String systemChatServer,
                    boolean actionsEnabled, boolean observationEnabled, String actionServer, boolean sttEnabled, String voiceServer,
                    String sttProvider, String sttUrl, String sttToken,
                    String ffmpegPath, String whisperCliPath, String whisperModelPath) {
    static final String SYSTEM_CHAT_SERVER = "mc.agicraft.ru:25565";

    static BridgeConfig load() throws IOException {
        Path path = FabricLoader.getInstance().getConfigDir().resolve("character-harness-bridge.properties");
        if (Files.notExists(path)) {
            Files.createDirectories(path.getParent());
            Files.writeString(path, "core_url=http://127.0.0.1:3000\ncharacter_name=Север\ntoken_file=\nsystem_chat_enabled=false\nsystem_chat_server=mc.agicraft.ru:25565\nactions_enabled=false\nobservation_enabled=false\naction_server=mc.agicraft.ru:25565\nstt_enabled=false\nvoice_server=mc.agicraft.ru:25565\nstt_provider=service\nstt_url=http://127.0.0.1:3082\nstt_token_file=\nffmpeg_path=/opt/homebrew/bin/ffmpeg\nwhisper_cli_path=\nwhisper_model_path=\n");
        }
        Properties properties = new Properties();
        try (var reader = Files.newBufferedReader(path)) { properties.load(reader); }
        String coreUrl = normalizeCoreUrl(properties.getProperty("core_url", "http://127.0.0.1:3000").trim());
        String tokenPath = properties.getProperty("token_file", "").trim();
        if (tokenPath.isEmpty()) throw new IOException("Set token_file in config/character-harness-bridge.properties");
        Path file = Path.of(tokenPath).toAbsolutePath().normalize();
        String token = Files.readString(file).trim();
        if (token.length() < 32) throw new IOException("Bridge token file is invalid");
        String characterName = properties.getProperty("character_name", "Север").trim();
        if (characterName.isEmpty() || characterName.length() > 32) throw new IOException("character_name is invalid");
        String enabledValue = properties.getProperty("system_chat_enabled", "false").trim();
        if (!enabledValue.equalsIgnoreCase("true") && !enabledValue.equalsIgnoreCase("false")) throw new IOException("system_chat_enabled must be true or false");
        boolean systemChatEnabled = Boolean.parseBoolean(enabledValue);
        String systemChatServer = normalizeSystemChatServer(properties.getProperty("system_chat_server", SYSTEM_CHAT_SERVER).trim());
        boolean actionsEnabled = strictBoolean(properties.getProperty("actions_enabled", "false"), "actions_enabled");
        boolean observationEnabled = strictBoolean(properties.getProperty("observation_enabled", "false"), "observation_enabled");
        boolean sttEnabled = strictBoolean(properties.getProperty("stt_enabled", "false"), "stt_enabled");
        validateFeatureGates(actionsEnabled, observationEnabled, sttEnabled);
        String actionServer = normalizeSystemChatServer(properties.getProperty("action_server", SYSTEM_CHAT_SERVER).trim());
        String voiceServer = normalizeSystemChatServer(properties.getProperty("voice_server", SYSTEM_CHAT_SERVER).trim());
        String sttProvider = properties.getProperty("stt_provider", "service").trim().toLowerCase(java.util.Locale.ROOT);
        if (!sttProvider.equals("service") && !sttProvider.equals("local")) throw new IOException("stt_provider must be service or local");
        String sttUrl = normalizeSttUrl(properties.getProperty("stt_url", "http://127.0.0.1:3082").trim());
        String sttToken = "";
        if (sttEnabled && sttProvider.equals("service")) {
            String sttTokenPath = properties.getProperty("stt_token_file", "").trim();
            if (sttTokenPath.isEmpty()) throw new IOException("Set stt_token_file when service STT is enabled");
            sttToken = Files.readString(Path.of(sttTokenPath).toAbsolutePath().normalize()).trim();
            if (sttToken.length() < 32) throw new IOException("STT service token file is invalid");
        }
        String ffmpeg = properties.getProperty("ffmpeg_path", "/opt/homebrew/bin/ffmpeg").trim();
        String whisper = properties.getProperty("whisper_cli_path", "").trim();
        String model = properties.getProperty("whisper_model_path", "").trim();
        if (sttEnabled && sttProvider.equals("local") && (ffmpeg.isEmpty() || whisper.isEmpty() || model.isEmpty()
                || !Files.isExecutable(Path.of(ffmpeg)) || !Files.isExecutable(Path.of(whisper)) || !Files.isRegularFile(Path.of(model)))) {
            throw new IOException("STT enabled but local ffmpeg, whisper-cli, or multilingual model path is invalid");
        }
        return new BridgeConfig(coreUrl, token, characterName, systemChatEnabled, systemChatServer, actionsEnabled, observationEnabled, actionServer, sttEnabled, voiceServer, sttProvider, sttUrl, sttToken, ffmpeg, whisper, model);
    }

    private static boolean strictBoolean(String value, String property) throws IOException {
        if (!value.equalsIgnoreCase("true") && !value.equalsIgnoreCase("false")) throw new IOException(property + " must be true or false");
        return Boolean.parseBoolean(value);
    }

    static void validateFeatureGates(boolean actionsEnabled, boolean observationEnabled, boolean sttEnabled) throws IOException {
        if ((actionsEnabled || sttEnabled) && !observationEnabled) {
            throw new IOException("observation_enabled must be true when actions_enabled or stt_enabled is true");
        }
    }

    static String normalizeCoreUrl(String value) throws IOException {
        return normalizeLoopbackUrl(value, "core_url");
    }

    static String normalizeSttUrl(String value) throws IOException {
        return normalizeLoopbackUrl(value, "stt_url");
    }

    private static String normalizeLoopbackUrl(String value, String property) throws IOException {
        final URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException error) {
            throw new IOException(property + " must be a valid loopback HTTP URL", error);
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
            throw new IOException(property + " must be loopback HTTP with a valid port and no credentials, path, query, or fragment");
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
