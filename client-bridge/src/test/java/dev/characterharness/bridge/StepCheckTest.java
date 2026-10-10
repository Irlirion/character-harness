package dev.characterharness.bridge;

import net.minecraft.util.math.Box;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StepCheckTest {
    @Test void reportsGroundingCollisionSupportAndUnknownChunksSeparately() {
        assertEquals("not_grounded", new ClientActionController.StepCheck(false, true, false, null, null).status(false));
        assertEquals("collision", new ClientActionController.StepCheck(true, true, false, "minecraft:oak_leaves", 1.0).status(true));
        assertEquals("no_support", new ClientActionController.StepCheck(false, false, false, null, null).status(true));
        assertEquals("unknown_chunk", new ClientActionController.StepCheck(true, false, true, null, null).status(true));
        assertEquals("clear", new ClientActionController.StepCheck(false, true, false, null, null).status(true));
    }

    @Test void recognizesFractionalFeetAboveActualCollisionSupport() {
        Box footprint=new Box(0.2,67.375,0.2,0.8,69.175,0.8);
        List<Box> fullBlock=worldBoxes(VoxelShapes.fullCube(),0,66,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.375,fullBlock));
    }

    @Test void recognizesSlabAndStairCollisionTreadsAtTheirActualTopHeights() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        VoxelShape bottomSlab=VoxelShapes.cuboid(0,0,0,1,0.5,1);
        VoxelShape stair=VoxelShapes.union(bottomSlab,VoxelShapes.cuboid(0,0.5,0.5,1,1,1));
        Box upperTreadFootprint=new Box(0.2,68,0.6,0.8,69.8,0.9);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,worldBoxes(bottomSlab,0,67,0)));
        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,worldBoxes(stair,0,67,0)));
        assertTrue(ClientActionController.hasSupportBelow(upperTreadFootprint,68,worldBoxes(stair,0,67,0)));
    }

    @Test void allowsHalfBlockStepDownButRejectsLowerOrMissingSupport() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        List<Box> halfBlockDown=worldBoxes(VoxelShapes.fullCube(),0,66,0);
        List<Box> fullBlockDown=worldBoxes(VoxelShapes.fullCube(),0,65,0);
        List<Box> lowSlab=worldBoxes(VoxelShapes.cuboid(0,0,0,1,0.5,1),0,66,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,halfBlockDown));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,fullBlockDown));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,lowSlab));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,List.of()));
    }

    private static List<Box> worldBoxes(VoxelShape shape,int x,int y,int z) {
        return shape.getBoundingBoxes().stream().map(box->box.offset(x,y,z)).toList();
    }
}
