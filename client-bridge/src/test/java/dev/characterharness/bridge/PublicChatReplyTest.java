package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PublicChatReplyTest {
    @Test void acceptsOneChatLineButNeverCommandsOrMultilineMessages() {
        assertTrue(PublicChatReply.valid("Привет, соседи!"));
        assertTrue(PublicChatReply.valid("x".repeat(256)));
        assertFalse(PublicChatReply.valid("x".repeat(257)));
        assertFalse(PublicChatReply.valid(" /op someone"));
        assertFalse(PublicChatReply.valid("hello\n/op someone"));
        assertFalse(PublicChatReply.valid("hello\rworld"));
        assertFalse(PublicChatReply.valid(null));
    }
}
