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
        assertEquals("not_grounded", new ClientActionController.StepCheck(false, true, false, null, null, null, null).status(false));
        assertEquals("collision", new ClientActionController.StepCheck(true, true, false, "minecraft:oak_leaves", 1.0, null, null).status(true));
        assertEquals("no_support", new ClientActionController.StepCheck(false, false, false, null, null, null, null).status(true));
        assertEquals("unknown_chunk", new ClientActionController.StepCheck(true, false, true, null, null, null, null).status(true));
        assertEquals("clear", new ClientActionController.StepCheck(false, true, false, null, null, null, null).status(true));
    }

    @Test void recognizesFractionalFeetAboveActualCollisionSupport() {
        Box footprint=new Box(0.2,67.375,0.2,0.8,69.175,0.8);
        List<Box> fullBlock=worldBoxes(VoxelShapes.fullCube(),0,66,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.375,fullBlock,3));
    }

    @Test void recognizesSlabAndStairCollisionTreadsAtTheirActualTopHeights() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        VoxelShape bottomSlab=VoxelShapes.cuboid(0,0,0,1,0.5,1);
        VoxelShape stair=VoxelShapes.union(bottomSlab,VoxelShapes.cuboid(0,0.5,0.5,1,1,1));
        Box upperTreadFootprint=new Box(0.2,68,0.6,0.8,69.8,0.9);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,worldBoxes(bottomSlab,0,67,0),3));
        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,worldBoxes(stair,0,67,0),3));
        assertTrue(ClientActionController.hasSupportBelow(upperTreadFootprint,68,worldBoxes(stair,0,67,0),3));
    }

    @Test void allowsSupportUpToSafeFallLimitButRejectsDeeperOrMissingSupport() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        List<Box> twoAndHalfBlockDown=worldBoxes(VoxelShapes.cuboid(0,0,0,1,0.5,1),0,64,0);
        List<Box> fourBlockDown=worldBoxes(VoxelShapes.cuboid(0,0,0,1,0.5,1),0,63,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,twoAndHalfBlockDown,3));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,fourBlockDown,3));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,List.of(),3));
    }

    @Test void recognizesDirtPathSupportWithinSafeFallDistance() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        List<Box> dirtPath=worldBoxes(VoxelShapes.cuboid(0,0,0,1,15.0/16.0,1),0,66,0);
        List<Box> lowerShape=worldBoxes(VoxelShapes.cuboid(0,0,0,1,15.0/16.0-0.001,1),0,66,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,dirtPath,3));
        assertEquals(0.5625,ClientActionController.nearestSupportDrop(footprint,67.5,dirtPath));
        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,lowerShape,3));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,List.of(),3));
    }

    @Test void clampsEffectiveSafeFallDistanceAndRejectsUncontrolledAirborneWalks() {
        assertEquals(0,ClientActionController.safeFallDistance(-1));
        assertEquals(1.25,ClientActionController.safeFallDistance(1.25));
        assertEquals(3,ClientActionController.safeFallDistance(3));
        assertEquals(3,ClientActionController.safeFallDistance(8));

        ClientActionController.StepCheck supported=new ClientActionController.StepCheck(false,true,false,null,null,"minecraft:dirt_path",0.4);
        ClientActionController.StepCheck collision=new ClientActionController.StepCheck(true,true,false,"minecraft:stone",1.0,"minecraft:dirt_path",0.4);
        ClientActionController.StepCheck unknown=new ClientActionController.StepCheck(false,true,true,null,null,"minecraft:dirt_path",0.4);
        ClientActionController.StepCheck noSupport=new ClientActionController.StepCheck(false,false,false,null,null,null,null);

        assertTrue(ClientActionController.safeControlledDescent(true,true,-0.04,67.5,67.3,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(false,true,-0.04,67.5,67.3,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(true,false,-0.04,67.5,67.3,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,0.01,67.5,67.3,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,-0.04,67.5,64.0,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,-0.04,67.5,67.3,collision,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,-0.04,67.5,67.3,unknown,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,-0.04,67.5,67.3,noSupport,3));
    }

    @Test void resetsFallBudgetAtEachGroundedDeparture() {
        ClientActionController.StepCheck supported=new ClientActionController.StepCheck(false,true,false,null,null,"minecraft:stone",0.4);
        assertTrue(ClientActionController.safeControlledDescent(true,true,-0.04,77.2,76.8,supported,3));
        assertFalse(ClientActionController.safeControlledDescent(true,true,-0.04,80.0,76.8,supported,3));
    }

    @Test void reportsNearestLowerSupportWithinThreeBlockDiagnosticWindow() {
        Box footprint=new Box(0.2,67.5,0.2,0.8,69.3,0.8);
        List<Box> halfBlockDown=worldBoxes(VoxelShapes.fullCube(),0,66,0);
        List<Box> oneBlockDown=worldBoxes(VoxelShapes.fullCube(),0,65,0);
        List<Box> atSafeFallLimit=worldBoxes(VoxelShapes.cuboid(0,0,0,1,0.5,1),0,64,0);
        List<Box> beyondSafeFall=worldBoxes(VoxelShapes.fullCube(),0,63,0);
        List<Box> outsideFootprint=worldBoxes(VoxelShapes.fullCube(),2,66,0);

        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,halfBlockDown,3));
        assertEquals(0.5,ClientActionController.nearestSupportDrop(footprint,67.5,halfBlockDown));
        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,oneBlockDown,3));
        assertEquals(1.5,ClientActionController.nearestSupportDrop(footprint,67.5,oneBlockDown));
        assertFalse(ClientActionController.hasSupportBelow(footprint,67.5,beyondSafeFall,3));
        assertTrue(ClientActionController.hasSupportBelow(footprint,67.5,atSafeFallLimit,3));
        assertEquals(3.0,ClientActionController.nearestSupportDrop(footprint,67.5,atSafeFallLimit));
        assertEquals(null,ClientActionController.nearestSupportDrop(footprint,67.5,beyondSafeFall));
        assertEquals(null,ClientActionController.nearestSupportDrop(footprint,67.5,outsideFootprint));
        assertEquals(null,ClientActionController.nearestSupportDrop(footprint,67.5,List.of()));
    }

    private static List<Box> worldBoxes(VoxelShape shape,int x,int y,int z) {
        return shape.getBoundingBoxes().stream().map(box->box.offset(x,y,z)).toList();
    }
}
