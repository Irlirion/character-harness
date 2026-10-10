package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SystemChatParserTest {
    @Test
    void extractsOnlyAddressedTextFromExpectedSystemChatShape() {
        var parsed = SystemChatParser.parse("<Irlirion> @Лада привет, как тебя зовут?", ChatAddress.pattern("Лада"));

        assertEquals("Irlirion", parsed.nickname());
        assertEquals("привет, как тебя зовут?", parsed.text());
    }

    @Test
    void rejectsUnaddressedMalformedAndNonPlayerLines() {
        var addressed = ChatAddress.pattern("Лада");
        assertNull(SystemChatParser.parse("<Irlirion> всем привет", addressed));
        assertNull(SystemChatParser.parse("Irlirion: @Лада привет", addressed));
        assertNull(SystemChatParser.parse("[Server] @Лада привет", addressed));
        assertNull(SystemChatParser.parse("<Irlirion extra> @Лада привет", addressed));
        assertNull(SystemChatParser.parse("<Irlirion> @Лада", addressed));
        assertNull(SystemChatParser.parse("<ThisNicknameIsMuchTooLong> @Лада привет", addressed));
    }
}
