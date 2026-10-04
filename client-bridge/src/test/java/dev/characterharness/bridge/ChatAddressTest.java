package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ChatAddressTest {
    @Test
    void matchesAuthorTextButNotFabricDecoratedDisplayText() {
        var addressed = ChatAddress.pattern("Север");

        assertEquals("привет", ChatAddress.extract("@Север привет", addressed));
        assertNull(ChatAddress.extract("<Player> @Север привет", addressed));
    }
}
