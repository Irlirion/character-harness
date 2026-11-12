package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ClientActionReadinessTest {
    @Test
    void distinguishesAnOpenScreenFromMissingClientState() {
        assertEquals("screen_opened", ClientActionController.startReadinessFailure(true, true, true, true));
        assertEquals("client_not_ready", ClientActionController.startReadinessFailure(false, true, true, true));
        assertEquals("client_not_ready", ClientActionController.startReadinessFailure(true, false, true, false));
        assertEquals("client_not_ready", ClientActionController.startReadinessFailure(true, true, false, false));
        assertNull(ClientActionController.startReadinessFailure(true, true, true, false));
    }
}
