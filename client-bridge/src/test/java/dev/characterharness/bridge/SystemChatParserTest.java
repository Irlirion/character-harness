package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SystemChatParserTest {
    @Test
    void extractsOnlyAddressedTextFromExpectedSystemChatShape() {
        var parsed = SystemChatParser.parse("<Irlirion> @Север привет, как тебя зовут?", ChatAddress.pattern("Север"));

        assertEquals("Irlirion", parsed.nickname());
        assertEquals("привет, как тебя зовут?", parsed.text());
    }

    @Test
    void rejectsUnaddressedMalformedAndNonPlayerLines() {
        var addressed = ChatAddress.pattern("Север");
        assertNull(SystemChatParser.parse("<Irlirion> всем привет", addressed));
        assertNull(SystemChatParser.parse("Irlirion: @Север привет", addressed));
        assertNull(SystemChatParser.parse("[Server] @Север привет", addressed));
        assertNull(SystemChatParser.parse("<Irlirion extra> @Север привет", addressed));
        assertNull(SystemChatParser.parse("<Irlirion> @Север", addressed));
        assertNull(SystemChatParser.parse("<ThisNicknameIsMuchTooLong> @Север привет", addressed));
    }
}
