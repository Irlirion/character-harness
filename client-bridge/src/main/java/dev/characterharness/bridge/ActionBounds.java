package dev.characterharness.bridge;

final class ActionBounds {
    private ActionBounds() {}
    record Direction(double dx, double dz) {}

    static boolean validWalk(double forward, double strafe, int durationMs) {
        return direction(forward) && direction(strafe) && (forward != 0 || strafe != 0)
                && durationMs >= 100 && durationMs <= 1200;
    }

    static boolean validTurn(double yaw, double pitch) {
        return Double.isFinite(yaw) && Double.isFinite(pitch) && Math.abs(yaw) <= 90 && Math.abs(pitch) <= 30;
    }

    static Direction horizontal(double yawDegrees, double forward, double strafeRight) {
        double yaw = Math.toRadians(yawDegrees);
        return new Direction(-Math.sin(yaw) * forward - Math.cos(yaw) * strafeRight,
                Math.cos(yaw) * forward - Math.sin(yaw) * strafeRight);
    }

    private static boolean direction(double n) { return Double.isFinite(n) && (n == -1 || n == 0 || n == 1); }
}
