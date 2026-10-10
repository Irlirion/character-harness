package dev.characterharness.bridge;

final class RelativeBearing {
    private RelativeBearing() {}
    static double degrees(double dx,double dz,double currentYaw) {
        double desiredYaw=Math.toDegrees(Math.atan2(-dx,dz));
        double difference=(desiredYaw-currentYaw)%360.0;
        if(difference>=180)difference-=360;
        if(difference< -180)difference+=360;
        return difference;
    }
}
