package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class RelativeBearingTest {
    @Test void matchesMinecraftYawDirection(){
        assertEquals(-90,RelativeBearing.degrees(1,0,0),0.001); // east is yaw -90
        assertEquals(90,RelativeBearing.degrees(-1,0,0),0.001); // west is yaw +90
        assertEquals(0,RelativeBearing.degrees(0,1,0),0.001); // south is yaw 0
        assertEquals(180,Math.abs(RelativeBearing.degrees(1,0,90)),0.001); // east from west is behind
    }
}
