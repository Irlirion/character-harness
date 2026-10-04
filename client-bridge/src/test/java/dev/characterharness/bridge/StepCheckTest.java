package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StepCheckTest {
    @Test void reportsGroundingCollisionSupportAndUnknownChunksSeparately() {
        assertEquals("not_grounded", new ClientActionController.StepCheck(false, true, false, null, null).status(false));
        assertEquals("collision", new ClientActionController.StepCheck(true, true, false, "minecraft:oak_leaves", 1.0).status(true));
        assertEquals("no_support", new ClientActionController.StepCheck(false, false, false, null, null).status(true));
        assertEquals("unknown_chunk", new ClientActionController.StepCheck(true, false, true, null, null).status(true));
        assertEquals("clear", new ClientActionController.StepCheck(false, true, false, null, null).status(true));
    }
}
