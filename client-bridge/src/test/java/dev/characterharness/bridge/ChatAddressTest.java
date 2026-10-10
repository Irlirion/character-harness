package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import net.minecraft.network.message.FilterMask;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ChatAddressTest {
    @Test
    void matchesAuthorTextButNotFabricDecoratedDisplayText() {
        var addressed = ChatAddress.pattern("Лада");

        assertEquals("привет", ChatAddress.extract("@Лада привет", addressed));
        assertNull(ChatAddress.extract("<Player> @Лада привет", addressed));
    }

    @Test
    void forwardsPartiallyFilteredContentOnlyAfterApplyingMask() {
        String signedContent = "@Лада секрет";
        FilterMask mask = new FilterMask(signedContent.length());
        for (int i = signedContent.indexOf("секрет"); i < signedContent.length(); i++) mask.markFiltered(i);

        assertEquals("######", ChatAddress.extract(signedContent, mask, ChatAddress.pattern("Лада")));
    }

    @Test
    void skipsFullyFilteredContent() {
        assertNull(ChatAddress.extract("@Лада секрет", FilterMask.FULLY_FILTERED, ChatAddress.pattern("Лада")));
    }
}
