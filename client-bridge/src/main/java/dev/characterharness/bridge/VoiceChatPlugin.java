package dev.characterharness.bridge;

import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.events.ClientReceiveSoundEvent;
import de.maxhenkel.voicechat.api.events.EventRegistration;

public final class VoiceChatPlugin implements VoicechatPlugin {
    @Override public String getPluginId() { return "character_harness_bridge"; }

    @Override public void registerEvents(EventRegistration registration) {
        registration.registerEvent(ClientReceiveSoundEvent.EntitySound.class, ClientBridge::onVoicePacket);
    }
}
