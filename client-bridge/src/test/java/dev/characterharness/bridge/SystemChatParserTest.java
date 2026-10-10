package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SystemChatParserTest {
    @Test
    void extractsAllUserTextFromPinnedSystemChatShape() {
        var parsed = SystemChatParser.parse("<Irlirion> привет, как тебя зовут?");

        assertEquals("Irlirion", parsed.nickname());
        assertEquals("привет, как тебя зовут?", parsed.text());
    }

    @Test
    void rejectsServerNotificationsAndMalformedLines() {
        assertEquals("не обращаясь к Ладе", SystemChatParser.parse("<Irlirion> не обращаясь к Ладе").text());
        assertNull(SystemChatParser.parse("Irlirion: @Лада привет"));
        assertNull(SystemChatParser.parse("[Server] игрок вошёл"));
        assertNull(SystemChatParser.parse("<Server> игрок вошёл"));
        assertNull(SystemChatParser.parse("<Irlirion extra> @Лада привет"));
        assertNull(SystemChatParser.parse("<Irlirion>   "));
        assertNull(SystemChatParser.parse("<ThisNicknameIsMuchTooLong> привет"));
    }
}
