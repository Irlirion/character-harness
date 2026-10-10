package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BridgeConfigTest {
    @Test
    void acceptsOnlyExactLocalHttpEndpoints() throws Exception {
        assertEquals("http://127.0.0.1:3000", BridgeConfig.normalizeCoreUrl("http://127.0.0.1:3000/"));
        assertEquals("http://localhost:3000", BridgeConfig.normalizeCoreUrl("http://LOCALHOST:3000"));
    }

    @Test
    void sttServiceUrlUsesTheSameStrictLoopbackBoundary() throws Exception {
        assertEquals("http://127.0.0.1:3082", BridgeConfig.normalizeSttUrl("http://127.0.0.1:3082/"));
        assertEquals("http://localhost:3082", BridgeConfig.normalizeSttUrl("http://LOCALHOST:3082"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSttUrl("http://127.0.0.1:3082@attacker.example"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSttUrl("http://user@127.0.0.1:3082"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSttUrl("https://127.0.0.1:3082"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSttUrl("http://127.0.0.1:3082/api"));
    }

    @Test
    void rejectsUserInfoHostConfusionAndUnexpectedUrlParts() {
        assertRejected("http://127.0.0.1:3000@attacker.example");
        assertRejected("http://user@127.0.0.1:3000");
        assertRejected("http://attacker.example:3000");
        assertRejected("https://127.0.0.1:3000");
        assertRejected("http://127.0.0.1:3000/api");
        assertRejected("http://127.0.0.1:3000/?next=attacker");
        assertRejected("http://127.0.0.1:3000/#fragment");
        assertRejected("http://127.0.0.1:0");
        assertRejected("http://127.0.0.1:65536");
        assertRejected("http://[::1]:3000");
    }

    @Test
    void systemChatAdapterIsBoundToTheKnownServer() throws Exception {
        assertEquals(BridgeConfig.SYSTEM_CHAT_SERVER, BridgeConfig.normalizeSystemChatServer("mc.agicraft.ru"));
        assertEquals(BridgeConfig.SYSTEM_CHAT_SERVER, BridgeConfig.normalizeSystemChatServer("MC.AGICRAFT.RU:25565"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSystemChatServer("mc.agicraft.ru:25566"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSystemChatServer("mc.agicraft.ru:25565@attacker.example"));
        assertThrows(IOException.class, () -> BridgeConfig.normalizeSystemChatServer("attacker.example:25565"));
    }

    @Test
    void actionsAndVoiceRequireWorldObservationOptIn() throws Exception {
        BridgeConfig.validateFeatureGates(false, false, false);
        BridgeConfig.validateFeatureGates(true, true, false);
        BridgeConfig.validateFeatureGates(false, true, true);
        assertThrows(IOException.class, () -> BridgeConfig.validateFeatureGates(true, false, false));
        assertThrows(IOException.class, () -> BridgeConfig.validateFeatureGates(false, false, true));
    }

    private static void assertRejected(String value) {
        assertThrows(IOException.class, () -> BridgeConfig.normalizeCoreUrl(value), value);
    }
}
