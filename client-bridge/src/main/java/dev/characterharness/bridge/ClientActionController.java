package dev.characterharness.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.BlockPos;

import java.util.function.BiConsumer;
import java.util.function.Predicate;
import java.util.Objects;

final class ClientActionController {
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
        if ("walk".equals(action.kind()) && (!client.player.isOnGround() || !safeStep(client,action))) {
            completion.accept(action,result("failed","unsafe_or_unsupported_step")); return;
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
        if ("walk".equals(action.kind()) && (!client.player.isOnGround() || !safeStep(client,action))) {
            finish(client,action,"cancelled","step_became_unsafe"); return;
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
        if ("walk".equals(action.kind())) release(client);
        JsonObject evidence = new JsonObject();
        evidence.addProperty("kind", action.kind());
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

    record StepCheck(boolean collisionAhead,boolean supportAhead) {}
    static StepCheck checkStep(MinecraftClient client,Action action) {
        ActionBounds.Direction direction=ActionBounds.horizontal(client.player.getYaw(),action.forward(),action.strafe());
        double dx=direction.dx()*0.35;
        double dz=direction.dz()*0.35;
        Box shifted=client.player.getBoundingBox().offset(dx,0,dz);
        BlockPos target=BlockPos.ofFloored(shifted.getCenter());
        BlockPos support=BlockPos.ofFloored(shifted.getCenter().x,shifted.minY-0.12,shifted.getCenter().z);
        if(!client.world.isChunkLoaded(target)||!client.world.isChunkLoaded(support))return new StepCheck(true,false);
        boolean collision=client.world.getBlockCollisions(client.player,shifted).iterator().hasNext();
        Box under=new Box(shifted.minX,shifted.minY-0.12,shifted.minZ,shifted.maxX,shifted.minY,shifted.maxZ);
        boolean supportAhead=client.world.getBlockCollisions(client.player,under).iterator().hasNext();
        return new StepCheck(collision,supportAhead);
    }

    private static Result result(String state, String reason) {
        JsonObject evidence = new JsonObject(); evidence.addProperty("reason", reason);
        return new Result(state, evidence);
    }

    static String startReadinessFailure(boolean hasPlayer, boolean hasWorld, boolean hasNetworkHandler, boolean screenOpen) {
        if (!hasPlayer || !hasWorld || !hasNetworkHandler) return "client_not_ready";
        return screenOpen ? "screen_opened" : null;
    }

}
