package dev.characterharness.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SystemChatParser {
    private static final Pattern PLAYER_LINE = Pattern.compile("^<([A-Za-z0-9_]{1,16})>\\s+(.+)$");

    record PlayerMessage(String nickname, String text) {}

    private SystemChatParser() {}

    static PlayerMessage parse(String visibleLine) {
        if (visibleLine == null) return null;
        Matcher line = PLAYER_LINE.matcher(visibleLine);
        if (!line.matches()) return null;
        String nickname=line.group(1);
        if(nickname.equalsIgnoreCase("server")||nickname.equalsIgnoreCase("console")||nickname.equalsIgnoreCase("system"))return null;
        String text=line.group(2).trim();
        return text.isEmpty() ? null : new PlayerMessage(nickname, text);
    }
}
