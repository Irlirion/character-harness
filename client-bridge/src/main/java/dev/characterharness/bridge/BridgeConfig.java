package dev.characterharness.bridge;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

record BridgeConfig(String coreUrl, String token, String characterName) {
    static BridgeConfig load() throws IOException {
        Path path = FabricLoader.getInstance().getConfigDir().resolve("character-harness-bridge.properties");
        if (Files.notExists(path)) {
            Files.createDirectories(path.getParent());
            Files.writeString(path, "core_url=http://127.0.0.1:3000\ncharacter_name=Север\ntoken_file=\n");
        }
        Properties properties = new Properties();
        try (var reader = Files.newBufferedReader(path)) { properties.load(reader); }
        String tokenPath = properties.getProperty("token_file", "").trim();
        if (tokenPath.isEmpty()) throw new IOException("Set token_file in config/character-harness-bridge.properties");
        Path file = Path.of(tokenPath).toAbsolutePath().normalize();
        String token = Files.readString(file).trim();
        if (token.length() < 32) throw new IOException("Bridge token file is invalid");
        String coreUrl = properties.getProperty("core_url", "http://127.0.0.1:3000").trim().replaceAll("/$", "");
        String characterName = properties.getProperty("character_name", "Север").trim();
        if (!coreUrl.startsWith("http://127.0.0.1:") && !coreUrl.startsWith("http://localhost:")) {
            throw new IOException("core_url must use local loopback HTTP");
        }
        if (characterName.isEmpty() || characterName.length() > 32) throw new IOException("character_name is invalid");
        return new BridgeConfig(coreUrl, token, characterName);
    }
}
