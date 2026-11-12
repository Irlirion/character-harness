package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class VoiceAddressTest {
    @Test void acceptsWakeNameWithOrWithoutPunctuationOnlyAtTheStart() {
        assertEquals("привет",VoiceAddress.extract("Север привет","Север"));
        assertEquals("повернись налево.",VoiceAddress.extract("Север, повернись налево.","Север"));
        assertEquals("ответь",VoiceAddress.extract("@Север: ответь","Север"));
        assertNull(VoiceAddress.extract("Северный привет","Север"));
        assertNull(VoiceAddress.extract("привет Север","Север"));
    }
}
