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

    private static void assertRejected(String value) {
        assertThrows(IOException.class, () -> BridgeConfig.normalizeCoreUrl(value), value);
    }
}
