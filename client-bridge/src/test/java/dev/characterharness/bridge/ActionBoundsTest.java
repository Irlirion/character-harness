package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ActionBoundsTest {
    @Test void acceptsOnlyDiscreteDirectionsAndShortDurations() {
        assertTrue(ActionBounds.validWalk(1,0,1200));
        assertTrue(ActionBounds.validWalk(-1,1,100));
        assertFalse(ActionBounds.validWalk(0,0,300));
        assertFalse(ActionBounds.validWalk(0.5,0,300));
        assertFalse(ActionBounds.validWalk(Double.NaN,0,300));
        assertFalse(ActionBounds.validWalk(1,0,1201));
    }

    @Test void boundsRelativeLook() {
        assertTrue(ActionBounds.validTurn(-90,30));
        assertFalse(ActionBounds.validTurn(90.1,0));
        assertFalse(ActionBounds.validTurn(0,Double.POSITIVE_INFINITY));
    }

    @Test void horizontalStepMatchesMinecraftForwardAndRightKeys() {
        assertDirection(0, 1, 0, 0, 1); // yaw zero looks south (+Z)
        assertDirection(0, 0, 1, -1, 0); // right is west (-X)
        assertDirection(0, 0, -1, 1, 0);
        assertDirection(90, 1, 0, -1, 0);
        assertDirection(90, 0, 1, 0, -1);
    }

    private static void assertDirection(double yaw, double forward, double strafe, double x, double z) {
        ActionBounds.Direction d = ActionBounds.horizontal(yaw, forward, strafe);
        assertEquals(x, d.dx(), 1e-9);
        assertEquals(z, d.dz(), 1e-9);
    }
}
