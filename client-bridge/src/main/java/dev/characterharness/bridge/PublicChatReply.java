package dev.characterharness.bridge;

final class PublicChatReply {
    private PublicChatReply() {}
    static boolean valid(String text) {
        return text != null && !text.isBlank() && text.length() <= 256
                && !text.stripLeading().startsWith("/")
                && text.chars().noneMatch(c -> c < 32 || c == 127);
    }
}
