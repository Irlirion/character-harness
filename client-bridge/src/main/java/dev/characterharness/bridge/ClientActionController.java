package dev.characterharness.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.BlockPos;
import net.minecraft.block.ShapeContext;
import net.minecraft.registry.Registries;
import net.minecraft.util.shape.VoxelShape;

import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Predicate;
import java.util.Objects;

final class ClientActionController {
    private static final int MAX_DIAGNOSTIC_BLOCKS=12;
    private static final int MAX_DIAGNOSTIC_SHAPES=64;
    // Minecraft dirt paths have a 15/16-block collision height; from a half-block tread this descent is 9/16.
    private static final double MAX_SAFE_STEP_DOWN=0.5+1.0/16.0;
    private static final double MAX_SUPPORT_DIAGNOSTIC_DEPTH=1.5;
    private static final double SUPPORT_EPSILON=1.0e-4;
    record Action(String id, String claimId, String kind, double forward, double strafe,
                  double yawDegrees, double pitchDegrees, int durationMs, long expiresAtMs, String sessionId) {}

    private final BiConsumer<Action, Result> completion;
    private final Predicate<String> currentSession;
    private volatile Action active;
    private long deadlineNanos;
    private Vec3d startPos;
    private float startYaw;
    private float startPitch;
    private float targetYaw;
    private float targetPitch;
    private boolean turnSet;
    private volatile long lastLeaseNanos;

    record Result(String state, JsonObject evidence) {}

    ClientActionController(BiConsumer<Action, Result> completion,Predicate<String> currentSession) { this.completion = completion; this.currentSession=currentSession; }
    Action active() { return active; }

    void start(MinecraftClient client, Action action) {
        if (active != null) { completion.accept(action, result("failed", "client_action_busy")); return; }
        if (System.currentTimeMillis() >= action.expiresAtMs()) { completion.accept(action, result("cancelled", "action_expired_before_start")); return; }
        if (!currentSession.test(action.sessionId())) { completion.accept(action,result("cancelled","world_session_mismatch")); return; }
        String readinessFailure = startReadinessFailure(client.player != null, client.world != null,
                client.getNetworkHandler() != null, client.currentScreen != null);
        if (readinessFailure != null) {
            completion.accept(action, result("failed", readinessFailure)); return;
        }
        if (client.options.forwardKey.isPressed() || client.options.backKey.isPressed()
                || client.options.leftKey.isPressed() || client.options.rightKey.isPressed()) {
            completion.accept(action, result("failed", "movement_input_busy")); return;
        }
        if (!"walk".equals(action.kind()) && !"turn".equals(action.kind())) {
            completion.accept(action, result("failed", "unsupported_action")); return;
        }
        if ("walk".equals(action.kind()) && !ActionBounds.validWalk(action.forward(),action.strafe(),action.durationMs())) {
            completion.accept(action, result("failed", "invalid_walk_bounds")); return;
        }
        if ("walk".equals(action.kind())) {
            StepCheck step=checkStep(client,action);
            if (!step.safe(client.player.isOnGround())) {
                completion.accept(action,result("failed","unsafe_or_unsupported_step",step,client.player.isOnGround())); return;
            }
        }
        if ("turn".equals(action.kind()) && !ActionBounds.validTurn(action.yawDegrees(),action.pitchDegrees())) {
            completion.accept(action, result("failed", "invalid_turn_bounds")); return;
        }
        active = action;
        startPos = new Vec3d(client.player.getX(),client.player.getY(),client.player.getZ());
        startYaw = net.minecraft.util.math.MathHelper.wrapDegrees(client.player.getYaw());
        startPitch = client.player.getPitch();
        targetYaw = startYaw;
        targetPitch = startPitch;
        int boundedDuration = "turn".equals(action.kind()) ? 1200 : Math.max(100, Math.min(action.durationMs(), 1200));
        deadlineNanos = System.nanoTime() + boundedDuration * 1_000_000L;
        lastLeaseNanos = System.nanoTime();
        turnSet = false;
        if ("walk".equals(action.kind())) setMovement(client, action);
    }

    void tick(MinecraftClient client) {
        Action action = active;
        if (action == null) return;
        if (client.player == null || client.world == null || client.getNetworkHandler() == null) {
            finish(client, action, "cancelled", "client_disconnected"); return;
        }
        if (client.currentScreen != null) { finish(client, action, "cancelled", "screen_opened"); return; }
        if (!currentSession.test(action.sessionId())) { finish(client,action,"cancelled","world_session_mismatch"); return; }
        if (System.nanoTime() - lastLeaseNanos > 500_000_000L) { finish(client, action, "cancelled", "action_lease_stale"); return; }
        if (System.nanoTime() >= deadlineNanos || System.currentTimeMillis() >= action.expiresAtMs()) {
            boolean moved = "walk".equals(action.kind()) && new Vec3d(client.player.getX(),client.player.getY(),client.player.getZ()).squaredDistanceTo(startPos) >= 0.0025;
            finish(client, action, moved ? "completed" : "failed", moved ? null : "action_expired_or_no_movement"); return;
        }
        if ("walk".equals(action.kind())) {
            StepCheck step=checkStep(client,action);
            if (!step.safe(client.player.isOnGround())) {
                finish(client,action,"cancelled","step_became_unsafe",step,client.player.isOnGround()); return;
            }
        }
        if ("turn".equals(action.kind()) && !turnSet) {
            targetYaw = net.minecraft.util.math.MathHelper.wrapDegrees(startYaw + (float) action.yawDegrees());
            targetPitch = Math.max(-90f, Math.min(90f, startPitch + (float) action.pitchDegrees()));
            client.player.setYaw(targetYaw);
            client.player.setPitch(targetPitch);
            turnSet = true;
            float yawError = Math.abs(net.minecraft.util.math.MathHelper.wrapDegrees(client.player.getYaw() - targetYaw));
            float pitchError = Math.abs(client.player.getPitch() - targetPitch);
            finish(client, action, yawError <= 0.1f && pitchError <= 0.1f ? "completed" : "failed",
                    yawError <= 0.1f && pitchError <= 0.1f ? null : "rotation_not_observed");
            return;
        }
    }

    void cancel(MinecraftClient client, String reason) {
        Action action = active;
        if (action != null) finish(client, action, "cancelled", reason);
    }

    void leaseCheck(MinecraftClient client, Action action, boolean valid) {
        Action running = active;
        if (running == null || !running.id().equals(action.id()) || !running.claimId().equals(action.claimId())) return;
        if (valid) lastLeaseNanos = System.nanoTime();
        else cancel(client,"action_lease_revoked");
    }

    private void finish(MinecraftClient client, Action action, String state, String reason) {
        finish(client,action,state,reason,null,false);
    }

    private void finish(MinecraftClient client, Action action, String state, String reason, StepCheck step, boolean onGround) {
        if ("walk".equals(action.kind())) release(client);
        JsonObject evidence = new JsonObject();
        evidence.addProperty("kind", action.kind());
        if(step!=null)step.addEvidence(evidence,onGround);
        if (client.player != null) {
            if (startPos != null) {
                evidence.addProperty("start_x", startPos.x); evidence.addProperty("start_y", startPos.y); evidence.addProperty("start_z", startPos.z);
            }
            evidence.addProperty("end_x", client.player.getX()); evidence.addProperty("end_y", client.player.getY()); evidence.addProperty("end_z", client.player.getZ());
            evidence.addProperty("start_yaw", net.minecraft.util.math.MathHelper.wrapDegrees(startYaw)); evidence.addProperty("end_yaw", net.minecraft.util.math.MathHelper.wrapDegrees(client.player.getYaw()));
            evidence.addProperty("start_pitch", startPitch); evidence.addProperty("end_pitch", client.player.getPitch());
        }
        if (reason != null) evidence.addProperty("reason", reason);
        active = null;
        startPos = null;
        completion.accept(action, new Result(state, evidence));
    }

    private static void setMovement(MinecraftClient client, Action a) {
        client.options.forwardKey.setPressed(a.forward() > 0);
        client.options.backKey.setPressed(a.forward() < 0);
        client.options.rightKey.setPressed(a.strafe() > 0);
        client.options.leftKey.setPressed(a.strafe() < 0);
    }

    private static void release(MinecraftClient client) {
        if (client.options == null) return;
        client.options.forwardKey.setPressed(false); client.options.backKey.setPressed(false);
        client.options.leftKey.setPressed(false); client.options.rightKey.setPressed(false);
    }

    static boolean safeStep(MinecraftClient client,Action action) {
        StepCheck check=checkStep(client,action);
        return !check.collisionAhead()&&check.supportAhead();
    }

    static boolean hasSupportBelow(Box footprint,double feetY,List<Box> worldShapes) {
        for(Box shape:worldShapes)if(hasSupportBelow(footprint,feetY,shape))return true;
        return false;
    }

    private static boolean hasSupportBelow(Box footprint,double feetY,Box shape) {
        double drop=feetY-shape.maxY;
        return intersectsSupportFootprint(footprint,shape)
                &&drop>=-SUPPORT_EPSILON&&drop<=MAX_SAFE_STEP_DOWN+SUPPORT_EPSILON;
    }

    private static boolean intersectsSupportFootprint(Box footprint,Box shape) {
        return shape.maxX>footprint.minX+SUPPORT_EPSILON&&shape.minX<footprint.maxX-SUPPORT_EPSILON
                &&shape.maxZ>footprint.minZ+SUPPORT_EPSILON&&shape.minZ<footprint.maxZ-SUPPORT_EPSILON;
    }

    static Double nearestSupportDrop(Box footprint,double feetY,List<Box> worldShapes) {
        double nearest=Double.POSITIVE_INFINITY;
        for(Box shape:worldShapes){
            double drop=feetY-shape.maxY;
            if(intersectsSupportFootprint(footprint,shape)&&drop>=-SUPPORT_EPSILON
                    &&drop<=MAX_SUPPORT_DIAGNOSTIC_DEPTH+SUPPORT_EPSILON)
                nearest=Math.min(nearest,Math.min(MAX_SUPPORT_DIAGNOSTIC_DEPTH,Math.max(0,drop)));
        }
        return Double.isFinite(nearest)?nearest:null;
    }

    record StepCheck(boolean collisionAhead,boolean supportAhead,boolean unknownChunk,String obstacleBlockId,Double estimatedStepUp,
                     String nearestSupportBlockId,Double nearestSupportDrop) {
        String status(boolean onGround) {
            if(!onGround)return "not_grounded";
            if(unknownChunk)return "unknown_chunk";
            if(collisionAhead)return "collision";
            if(!supportAhead)return "no_support";
            return "clear";
        }
        boolean safe(boolean onGround) { return "clear".equals(status(onGround)); }
        void addSummary(JsonObject target,boolean onGround) {
            target.addProperty("step_status",status(onGround));
            if(obstacleBlockId!=null)target.addProperty("obstacle_block_id",obstacleBlockId);
            if(estimatedStepUp!=null)target.addProperty("estimated_step_up",estimatedStepUp);
            if(nearestSupportBlockId!=null)target.addProperty("nearest_support_block_id",nearestSupportBlockId);
            if(nearestSupportDrop!=null)target.addProperty("nearest_support_drop",nearestSupportDrop);
        }
        void addEvidence(JsonObject target,boolean onGround) {
            target.addProperty("on_ground",onGround);
            target.addProperty("collision_ahead",collisionAhead);
            target.addProperty("support_ahead",supportAhead);
            addSummary(target,onGround);
        }
    }
    static StepCheck checkStep(MinecraftClient client,Action action) {
        ActionBounds.Direction direction=ActionBounds.horizontal(client.player.getYaw(),action.forward(),action.strafe());
        double dx=direction.dx()*0.35;
        double dz=direction.dz()*0.35;
        Box shifted=client.player.getBoundingBox().offset(dx,0,dz);
        int minX=net.minecraft.util.math.MathHelper.floor(shifted.minX+1.0e-7),maxX=net.minecraft.util.math.MathHelper.floor(shifted.maxX-1.0e-7);
        int minY=net.minecraft.util.math.MathHelper.floor(shifted.minY+1.0e-7),maxY=net.minecraft.util.math.MathHelper.floor(shifted.maxY-1.0e-7);
        int minZ=net.minecraft.util.math.MathHelper.floor(shifted.minZ+1.0e-7),maxZ=net.minecraft.util.math.MathHelper.floor(shifted.maxZ-1.0e-7);
        long blockCount=(long)(maxX-minX+1)*(maxY-minY+1)*(maxZ-minZ+1);
        if(blockCount<=0||blockCount>MAX_DIAGNOSTIC_BLOCKS)return new StepCheck(true,false,true,null,null,null,null);
        for(int x=minX;x<=maxX;x++)for(int y=minY;y<=maxY;y++)for(int z=minZ;z<=maxZ;z++)
            if(!client.world.isChunkLoaded(new BlockPos(x,y,z)))return new StepCheck(true,false,true,null,null,null,null);
        int supportMinY=net.minecraft.util.math.MathHelper.floor(shifted.minY-MAX_SAFE_STEP_DOWN-SUPPORT_EPSILON);
        int supportMaxY=net.minecraft.util.math.MathHelper.floor(shifted.minY-SUPPORT_EPSILON);
        long supportBlockCount=(long)(maxX-minX+1)*(supportMaxY-supportMinY+1)*(maxZ-minZ+1);
        if(supportBlockCount<=0||supportBlockCount>MAX_DIAGNOSTIC_BLOCKS)return new StepCheck(true,false,true,null,null,null,null);
        for(int x=minX;x<=maxX;x++)for(int y=supportMinY;y<=supportMaxY;y++)for(int z=minZ;z<=maxZ;z++)
            if(!client.world.isChunkLoaded(new BlockPos(x,y,z)))return new StepCheck(true,false,true,null,null,null,null);
        boolean collision=client.world.getBlockCollisions(client.player,shifted).iterator().hasNext();
        boolean supportAhead=false;int inspectedSupportShapes=0;
        support: for(int x=minX;x<=maxX;x++)for(int y=supportMinY;y<=supportMaxY;y++)for(int z=minZ;z<=maxZ;z++){
            BlockPos pos=new BlockPos(x,y,z);
            VoxelShape shape=client.world.getBlockState(pos).getCollisionShape(client.world,pos,ShapeContext.of(client.player));
            for(Box local:shape.getBoundingBoxes()){
                if(inspectedSupportShapes++>=MAX_DIAGNOSTIC_SHAPES)return new StepCheck(collision,false,true,null,null,null,null);
                if(hasSupportBelow(shifted,shifted.minY,local.offset(x,y,z))){supportAhead=true;break support;}
            }
        }
        String nearestSupportBlockId=null;Double nearestSupportDrop=null;
        int diagnosticMinY=net.minecraft.util.math.MathHelper.floor(shifted.minY-MAX_SUPPORT_DIAGNOSTIC_DEPTH-SUPPORT_EPSILON);
        int diagnosticMaxY=net.minecraft.util.math.MathHelper.floor(shifted.minY-SUPPORT_EPSILON);
        long diagnosticBlockCount=(long)(maxX-minX+1)*(diagnosticMaxY-diagnosticMinY+1)*(maxZ-minZ+1);
        if(diagnosticBlockCount>0&&diagnosticBlockCount<=MAX_DIAGNOSTIC_BLOCKS){
            boolean loaded=true;
            for(int x=minX;x<=maxX&&loaded;x++)for(int y=diagnosticMinY;y<=diagnosticMaxY&&loaded;y++)for(int z=minZ;z<=maxZ;z++)
                if(!client.world.isChunkLoaded(new BlockPos(x,y,z))){loaded=false;break;}
            if(loaded){
                int inspected=0;double nearest=Double.POSITIVE_INFINITY;
                supportScan: for(int x=minX;x<=maxX;x++)for(int y=diagnosticMinY;y<=diagnosticMaxY;y++)for(int z=minZ;z<=maxZ;z++){
                    BlockPos pos=new BlockPos(x,y,z);var state=client.world.getBlockState(pos);
                    VoxelShape shape=state.getCollisionShape(client.world,pos,ShapeContext.of(client.player));
                    for(Box local:shape.getBoundingBoxes()){
                        if(inspected++>=MAX_DIAGNOSTIC_SHAPES)break supportScan;
                        Box worldBox=local.offset(x,y,z);double drop=shifted.minY-worldBox.maxY;
                        if(!intersectsSupportFootprint(shifted,worldBox)||drop< -SUPPORT_EPSILON
                                ||drop>MAX_SUPPORT_DIAGNOSTIC_DEPTH+SUPPORT_EPSILON||drop>=nearest)continue;
                        String blockId=Registries.BLOCK.getId(state.getBlock()).toString();if(blockId.length()>128)continue;
                        nearest=Math.min(MAX_SUPPORT_DIAGNOSTIC_DEPTH,Math.max(0,drop));nearestSupportDrop=nearest;nearestSupportBlockId=blockId;
                    }
                }
            }
        }
        String obstacleBlockId=null;Double estimatedStepUp=null;
        if(collision){
            double nearest=Double.POSITIVE_INFINITY;var targetCenter=shifted.getCenter();int inspectedShapes=0;
            scan: for(int x=minX;x<=maxX;x++)for(int y=minY;y<=maxY;y++)for(int z=minZ;z<=maxZ;z++){
                BlockPos pos=new BlockPos(x,y,z);var state=client.world.getBlockState(pos);
                VoxelShape shape=state.getCollisionShape(client.world,pos,ShapeContext.of(client.player));
                for(Box local:shape.getBoundingBoxes()){
                    if(inspectedShapes++>=MAX_DIAGNOSTIC_SHAPES)break scan;
                    Box worldBox=local.offset(x,y,z);if(!worldBox.intersects(shifted))continue;
                    double distance=worldBox.getCenter().squaredDistanceTo(targetCenter);
                    if(distance>=nearest)continue;
                    String blockId=Registries.BLOCK.getId(state.getBlock()).toString();
                    if(blockId.length()>128)continue;
                    nearest=distance;obstacleBlockId=blockId;
                    estimatedStepUp=Math.max(0,Math.min(2,worldBox.maxY-client.player.getY()));
                }
            }
        }
        return new StepCheck(collision,supportAhead,false,obstacleBlockId,estimatedStepUp,nearestSupportBlockId,nearestSupportDrop);
    }

    private static Result result(String state, String reason) {
        JsonObject evidence = new JsonObject(); evidence.addProperty("reason", reason);
        return new Result(state, evidence);
    }

    private static Result result(String state,String reason,StepCheck step,boolean onGround) {
        JsonObject evidence=new JsonObject();evidence.addProperty("reason",reason);step.addEvidence(evidence,onGround);
        return new Result(state,evidence);
    }

    static String startReadinessFailure(boolean hasPlayer, boolean hasWorld, boolean hasNetworkHandler, boolean screenOpen) {
        if (!hasPlayer || !hasWorld || !hasNetworkHandler) return "client_not_ready";
        return screenOpen ? "screen_opened" : null;
    }

}
