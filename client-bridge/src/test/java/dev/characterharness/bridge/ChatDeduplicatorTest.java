package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatDeduplicatorTest {
    @Test
    void suppressesCrossPathDuplicateButKeepsRepeatedMessagesFromOnePath() {
        var dedupe=new ChatDeduplicator();
        assertTrue(dedupe.claim("Player","hello","chat",1_000));
        assertTrue(dedupe.claim("Player","hello","chat",2_000));
        assertFalse(dedupe.claim("player","hello","game",3_000));
        assertTrue(dedupe.claim("Player","hello","game",2_000_002_001L));
    }
}
