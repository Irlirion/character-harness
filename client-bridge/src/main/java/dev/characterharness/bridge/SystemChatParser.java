package dev.characterharness.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SystemChatParser {
    private static final Pattern PLAYER_LINE = Pattern.compile("^<([A-Za-z0-9_]{1,16})>\\s+(.+)$");

    record AddressedMessage(String nickname, String text) {}

    private SystemChatParser() {}

    static AddressedMessage parse(String visibleLine, Pattern addressed) {
        if (visibleLine == null) return null;
        Matcher line = PLAYER_LINE.matcher(visibleLine);
        if (!line.matches()) return null;
        String text = ChatAddress.extract(line.group(2), addressed);
        return text == null ? null : new AddressedMessage(line.group(1), text);
    }
}
