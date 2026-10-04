package dev.characterharness.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.MathHelper;
import net.minecraft.world.RaycastContext;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import de.maxhenkel.voicechat.api.events.ClientReceiveSoundEvent;

public final class ClientBridge implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("CharacterHarnessBridge");
    private static volatile ClientBridge instance;
    private final Set<String> queuedReplies = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> recentlyForwarded = new ConcurrentHashMap<>();
    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "character-harness-bridge");
        thread.setDaemon(true);
        return thread;
    });
    private final ScheduledExecutorService actionIo = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "character-harness-actions"); thread.setDaemon(true); return thread;
    });
    private final ScheduledExecutorService observationIo = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r,"character-harness-observations"); thread.setDaemon(true); return thread;
    });
    private final ThreadPoolExecutor sttIo = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new LinkedBlockingQueue<>(4),r -> {
        Thread thread = new Thread(r,"character-harness-local-stt"); thread.setDaemon(true); return thread;
    },new ThreadPoolExecutor.AbortPolicy());
    private final PcmSegmenter pcmSegmenter = new PcmSegmenter();
    private final AtomicInteger queuedVoiceFrames=new AtomicInteger();
    private final Map<String, Long> recentlySpoken = new ConcurrentHashMap<>();
    private volatile Map<UUID,JsonObject> nearbyPlayers = Map.of();
    private volatile String activeWorldSessionId;
    private volatile boolean actionServerEligible;
    private String activeWorldServer;
    private Object activeNetworkHandler;
    private Object activeWorldRef;
    private int observationTicks;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).followRedirects(HttpClient.Redirect.NEVER).build();
    private BridgeConfig config;
    private SttServiceClient sttService;
    private Pattern addressed;
    private boolean systemServerWarningLogged;
    private ClientActionController actionController;

    @Override public void onInitializeClient() {
        try {
            instance = this;
            config = BridgeConfig.load();
            if (config.sttEnabled()) {
                sttService = new SttServiceClient(http, config.sttUrl(), config.sttToken());
            }
            addressed = ChatAddress.pattern(config.characterName());
        } catch (Exception error) {
            LOG.error("Bridge disabled: {}", error.getMessage());
            return;
        }
        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, received) -> onChat(signed, sender, received));
        if (config.systemChatEnabled()) {
            ClientReceiveMessageEvents.GAME.register((message, overlay) -> onSystemChat(message.getString(), overlay));
            LOG.info("Unverified system-chat adapter enabled for {}; it is limited to the public demo scope.", config.systemChatServer());
        }
        actionController = new ClientActionController(this::completeClientAction,id -> java.util.Objects.equals(activeWorldSessionId,id));
        ClientTickEvents.END_CLIENT_TICK.register(this::onClientTick);
        ClientLifecycleEvents.CLIENT_STOPPING.register(this::onClientStopping);
        io.scheduleWithFixedDelay(this::pollReplies, 1, 1, TimeUnit.SECONDS);
        if (config.actionsEnabled()) actionIo.scheduleWithFixedDelay(this::pollActions, 0, 150, TimeUnit.MILLISECONDS);
        LOG.info("Bridge enabled for addressed chat; account UUIDs are forwarded as supplied by the server chat context. systemChatEnabled={}", config.systemChatEnabled());
    }

    private void onClientStopping(MinecraftClient client) {
        if (actionController != null) actionController.cancel(client, "client_shutdown");
        pcmSegmenter.clear();
        clearQueuedStt();
        io.shutdownNow();
        observationIo.shutdownNow();
        actionIo.shutdown();
        sttIo.shutdownNow();
        instance = null;
    }

    static void onVoicePacket(ClientReceiveSoundEvent.EntitySound event) {
        ClientBridge bridge = instance;
        if (bridge == null || bridge.config == null || !bridge.config.sttEnabled()) return;
        String sessionId = bridge.activeWorldSessionId;
        if (sessionId == null) return;
        UUID speaker=event.getId();
        if(speaker==null||event.isWhispering())return;
        if(bridge.queuedVoiceFrames.incrementAndGet()>40){bridge.queuedVoiceFrames.decrementAndGet();return;}
        short[] raw=event.getRawAudio();
        if(raw!=null&&raw.length>9600){bridge.queuedVoiceFrames.decrementAndGet();return;}
        short[] frame=raw==null?new short[0]:raw.clone();
        MinecraftClient.getInstance().execute(()->{try{if(java.util.Objects.equals(sessionId,bridge.activeWorldSessionId))bridge.receiveVoicePacket(speaker,frame);}finally{java.util.Arrays.fill(frame,(short)0);bridge.queuedVoiceFrames.decrementAndGet();}});
    }

    private void receiveVoicePacket(UUID speaker,short[] frame) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || !isAllowedVoiceServer(client.getCurrentServerEntry()) || speaker.equals(client.player.getUuid()) || activeWorldSessionId==null) return;
        PcmSegmenter.Segment segment = pcmSegmenter.accept(speaker, frame);
        if (segment != null) {
            SttTask task=new SttTask(segment,activeWorldSessionId,resolveOnlineProfile(client,speaker));
            try { sttIo.execute(task); }
            catch (RuntimeException full) { task.clear(); LOG.warn("STT queue full; dropping bounded voice segment."); }
        }
    }

    private boolean isAllowedVoiceServer(ServerInfo server) {
        if (server == null) return false;
        try { return config.voiceServer().equals(BridgeConfig.normalizeSystemChatServer(server.address)); }
        catch (Exception ignored) { return false; }
    }

    private final class SttTask implements Runnable {
        private final PcmSegmenter.Segment segment; private final String sessionId; private final JsonObject speakerMetadata;
        private SttTask(PcmSegmenter.Segment segment,String sessionId,JsonObject speakerMetadata){this.segment=segment;this.sessionId=sessionId;this.speakerMetadata=speakerMetadata;}
        private void clear(){java.util.Arrays.fill(segment.samples(),(short)0);}
        @Override public void run(){
            try {
                String transcript = sttService.transcribe(segment.samples());
                String text = VoiceAddress.extract(transcript,config.characterName());
                if (text == null || text.isBlank() || text.length() > 1000 || isRecentBotSpeech(text)
                        || !java.util.Objects.equals(activeWorldSessionId,sessionId)) return;
                String server = config.voiceServer();
                String author = "minecraft-voice:" + server + ":" + segment.speaker();
                String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
                String sourceKey = author + ":" + Instant.now().toEpochMilli() + ":" + digest;
                JsonObject metadata=speakerMetadata.deepCopy(); JsonObject observed=nearbyPlayers.get(segment.speaker());
                if(observed!=null){JsonObject profile=new JsonObject();profile.addProperty("uuid",segment.speaker().toString());profile.addProperty("name",observed.get("name").getAsString());profile.addProperty("distance",observed.get("distance").getAsDouble());profile.addProperty("bearing_degrees",observed.get("bearing_degrees").getAsDouble());profile.addProperty("line_of_sight",observed.get("line_of_sight").getAsBoolean());metadata.add("observed_profile",profile);}
                forwardEvent(sourceKey, author, "minecraft_voice_stt", server, text,metadata);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (Exception error) { LOG.warn("Voice transcription failed: {}", error.getClass().getSimpleName()); }
            finally { clear(); }
        }
    }

    private boolean isRecentBotSpeech(String text) {
        long now = System.nanoTime();
        String key = normalizeSpeech(text);
        recentlySpoken.entrySet().removeIf(entry -> now - entry.getValue() > TimeUnit.SECONDS.toNanos(30));
        return recentlySpoken.containsKey(key);
    }

    private static String normalizeSpeech(String text) {
        return text.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", " ").trim();
    }

    private void pollActions() {
        try {
            MinecraftClient client = MinecraftClient.getInstance();
            if (!config.actionsEnabled() || !actionServerEligible) {
                ClientActionController.Action active = actionController.active();
                if (active != null) client.execute(() -> actionController.cancel(client, "test_server_gate_closed"));
                return;
            }
            ClientActionController.Action active = actionController.active();
            if (active != null) {
                JsonObject body = new JsonObject(); body.addProperty("claim_id", active.claimId());
                HttpResponse<String> lease = request("POST", "/bridge/actions/" + active.id() + "/lease", body.toString());
                boolean valid = lease.statusCode() == 200 && JsonParser.parseString(lease.body()).getAsJsonObject().get("valid").getAsBoolean();
                client.execute(() -> actionController.leaseCheck(client, active, valid));
                return;
            }
            HttpResponse<String> response = request("POST", "/bridge/actions/claim", "{}");
            if (response.statusCode() != 200) return;
            JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
            if (root.get("action").isJsonNull()) return;
            ClientActionController.Action action = parseAction(root.getAsJsonObject("action"));
            JsonObject leaseBody=new JsonObject();leaseBody.addProperty("claim_id",action.claimId());
            HttpResponse<String> lease=request("POST","/bridge/actions/"+action.id()+"/lease",leaseBody.toString());
            boolean valid=lease.statusCode()==200&&JsonParser.parseString(lease.body()).getAsJsonObject().get("valid").getAsBoolean();
            if(!valid){completeClientAction(action,new ClientActionController.Result("cancelled",reasonEvidence("initial_lease_invalid")));return;}
            client.execute(() -> {
                if (!actionServerEligible) { completeClientAction(action,new ClientActionController.Result("cancelled",reasonEvidence("test_server_gate_closed"))); return; }
                actionController.start(client,action);
            });
        } catch (Exception error) {
            ClientActionController.Action active=actionController.active();
            if(active!=null)MinecraftClient.getInstance().execute(()->actionController.leaseCheck(MinecraftClient.getInstance(),active,false));
            LOG.warn("Action bridge poll failed: {}", error.getClass().getSimpleName());
        }
    }

    private boolean isAllowedActionServer(ServerInfo server) {
        if (!config.actionsEnabled() || server == null) return false;
        try { return config.actionServer().equals(BridgeConfig.normalizeSystemChatServer(server.address)); }
        catch (Exception ignored) { return false; }
    }

    private static ClientActionController.Action parseAction(JsonObject json) {
        return new ClientActionController.Action(json.get("id").getAsString(),json.get("claim_id").getAsString(),json.get("kind").getAsString(),
                json.getAsJsonObject("args").has("forward")?json.getAsJsonObject("args").get("forward").getAsDouble():0,
                json.getAsJsonObject("args").has("strafe")?json.getAsJsonObject("args").get("strafe").getAsDouble():0,
                json.getAsJsonObject("args").has("yaw_degrees")?json.getAsJsonObject("args").get("yaw_degrees").getAsDouble():0,
                json.getAsJsonObject("args").has("pitch_degrees")?json.getAsJsonObject("args").get("pitch_degrees").getAsDouble():0,
                json.get("duration_ms").getAsInt(),OffsetDateTime.parse(json.get("expires_at").getAsString()).toInstant().toEpochMilli(),json.get("session_id").getAsString());
    }

    private void onClientTick(MinecraftClient client) {
        syncWorldSession(client);
        if(config.observationEnabled()&&activeWorldSessionId!=null&&++observationTicks>=20){observationTicks=0;publishWorldObservation(client);}
        if (actionController != null) actionController.tick(client);
    }

    private void syncWorldSession(MinecraftClient client){
        String server=null;
        boolean featureEnabled=config.observationEnabled()||config.actionsEnabled()||config.sttEnabled();
        if(featureEnabled&&client.player!=null&&client.world!=null&&client.getNetworkHandler()!=null){
            try{String candidate=BridgeConfig.normalizeSystemChatServer(client.getCurrentServerEntry().address);
                if((config.observationEnabled()&&candidate.equals(config.actionServer()))
                    ||(config.actionsEnabled()&&candidate.equals(config.actionServer()))
                    ||(config.sttEnabled()&&candidate.equals(config.voiceServer())))server=candidate;
            }catch(Exception ignored){}
        }
        actionServerEligible=config.actionsEnabled()&&server!=null&&server.equals(config.actionServer());
        Object network=server==null?null:client.getNetworkHandler();Object world=server==null?null:client.world;
        if(java.util.Objects.equals(server,activeWorldServer)&&network==activeNetworkHandler&&world==activeWorldRef)return;
        String old=activeWorldSessionId;
        activeWorldServer=server;
        activeWorldSessionId=server==null?null:UUID.randomUUID().toString();
        activeNetworkHandler=network;activeWorldRef=world;
        pcmSegmenter.clear(); nearbyPlayers=Map.of();
        clearQueuedStt();
        if(config.observationEnabled()&&old!=null)postDisconnectedObservation(old);
    }

    private void clearQueuedStt(){
        for(Runnable runnable:sttIo.getQueue().toArray(Runnable[]::new))if(runnable instanceof ClientBridge.SttTask task){if(sttIo.getQueue().remove(task))task.clear();}
    }

    private void completeClientAction(ClientActionController.Action action, ClientActionController.Result result) {
        actionIo.execute(() -> {
            try {
                JsonObject body = new JsonObject(); body.addProperty("claim_id",action.claimId()); body.addProperty("state",result.state()); body.add("evidence",result.evidence());
                HttpResponse<String> response = request("POST","/bridge/actions/"+action.id(),body.toString());
                if (response.statusCode()!=200) LOG.warn("Action result rejected with status {}",response.statusCode());
            } catch (Exception error) { LOG.warn("Could not report bounded action completion: {}",error.getClass().getSimpleName()); }
        });
    }

    private static JsonObject reasonEvidence(String reason) { JsonObject e=new JsonObject(); e.addProperty("reason",reason); return e; }

    private void onChat(SignedMessage signed, com.mojang.authlib.GameProfile sender, Instant received) {
        if (signed == null || signed.isSenderMissing() || sender == null) return;
        UUID profileId = sender.id();
        UUID author = signed.getSender();
        if (!author.equals(profileId)) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.player.getUuid().equals(author)) return;
        String text = ChatAddress.extract(signed.getSignedContent(), signed.filterMask(), addressed);
        if (text == null) return;
        if (text.isEmpty() || text.length() > 1000) return;
        if (!claimRecent(sender.name(), text)) return;
        try {
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
            String sourceKey = "minecraft:" + author + ":" + received.toEpochMilli() + ":" + digest;
            forwardEvent(sourceKey, author.toString(), "fabric_profile_context", null, text);
        } catch (Exception error) {
            LOG.warn("Could not forward chat event: {}", error.getClass().getSimpleName());
        }
    }

    private void onSystemChat(String visibleLine, boolean overlay) {
        if (overlay || !config.systemChatEnabled()) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || !isAllowedSystemChatServer(client.getCurrentServerEntry())) return;
        SystemChatParser.AddressedMessage parsed = SystemChatParser.parse(visibleLine, addressed);
        if (parsed == null || parsed.text().length() > 1000
                || client.player.getName().getString().equalsIgnoreCase(parsed.nickname())
                || !claimRecent(parsed.nickname(), parsed.text())) return;
        try {
            String nickname = parsed.nickname().toLowerCase(Locale.ROOT);
            String authorId = "minecraft-system:" + config.systemChatServer() + ":" + nickname;
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(parsed.text().getBytes(StandardCharsets.UTF_8)));
            String sourceKey = "minecraft-system:" + config.systemChatServer() + ":" + nickname + ":" + Instant.now().toEpochMilli() + ":" + digest;
            JsonObject metadata=resolveOnlineProfile(client,parsed.nickname());
            forwardEvent(sourceKey, authorId, "minecraft_system_chat", config.systemChatServer(), parsed.text(),metadata);
        } catch (Exception error) {
            LOG.warn("Could not forward system chat event: {}", error.getClass().getSimpleName());
        }
    }

    private boolean isAllowedSystemChatServer(ServerInfo server) {
        if (server == null) return false;
        try {
            String address = BridgeConfig.normalizeSystemChatServer(server.address);
            if (config.systemChatServer().equals(address)) return true;
        } catch (Exception ignored) {
            // Treat malformed or non-target addresses identically; never include a server-provided string in logs.
        }
        if (!systemServerWarningLogged) {
            systemServerWarningLogged = true;
            LOG.warn("System-chat event ignored: connected server is not the configured test server.");
        }
        return false;
    }

    private synchronized boolean claimRecent(String nickname, String text) {
        long now = System.nanoTime();
        String key = nickname.toLowerCase(Locale.ROOT) + "\u0000" + text;
        Long previous = recentlyForwarded.get(key);
        recentlyForwarded.entrySet().removeIf(entry -> now - entry.getValue() > TimeUnit.SECONDS.toNanos(2));
        if (previous != null && now - previous <= TimeUnit.SECONDS.toNanos(2)) return false;
        recentlyForwarded.put(key, now);
        return true;
    }

    private void forwardEvent(String sourceKey, String authorId, String authorProvenance, String sourceServer, String text) {
        forwardEvent(sourceKey,authorId,authorProvenance,sourceServer,text,null);
    }

    private void forwardEvent(String sourceKey, String authorId, String authorProvenance, String sourceServer, String text,JsonObject metadata) {
        JsonObject body = new JsonObject();
        body.addProperty("source_key", sourceKey);
        body.addProperty("author_id", authorId);
        body.addProperty("author_provenance", authorProvenance);
        if (sourceServer != null) body.addProperty("source_server", sourceServer);
        if(metadata!=null&&!metadata.entrySet().isEmpty())body.add("author_metadata",metadata);
        body.addProperty("text", text);
        io.execute(() -> {
            try {
                HttpResponse<String> response = request("POST", "/bridge/events", body.toString());
                if (response.statusCode() != 200) LOG.warn("Core rejected chat event with status {}", response.statusCode());
            } catch (Exception error) {
                LOG.warn("Could not forward chat event: {}", error.getClass().getSimpleName());
            }
        });
    }

    private JsonObject resolveOnlineProfile(MinecraftClient client,String nickname){
        if(client.getNetworkHandler()==null)return new JsonObject();
        var matches=client.getNetworkHandler().getPlayerList().stream()
                .map(entry->entry.getProfile()).filter(profile->profile.name().equalsIgnoreCase(nickname)).toList();
        if(matches.size()!=1)return new JsonObject();
        JsonObject profile=new JsonObject();profile.addProperty("uuid",matches.getFirst().id().toString());profile.addProperty("name",matches.getFirst().name());
        JsonObject metadata=new JsonObject();metadata.add("observed_profile",profile);return metadata;
    }

    private JsonObject resolveOnlineProfile(MinecraftClient client,UUID uuid){
        if(client.getNetworkHandler()==null)return new JsonObject();
        var matches=client.getNetworkHandler().getPlayerList().stream().map(entry->entry.getProfile()).filter(profile->profile.id().equals(uuid)).toList();
        if(matches.size()!=1)return new JsonObject();
        JsonObject profile=new JsonObject();profile.addProperty("uuid",uuid.toString());profile.addProperty("name",matches.getFirst().name());
        JsonObject metadata=new JsonObject();metadata.add("observed_profile",profile);return metadata;
    }

    private void publishWorldObservation(MinecraftClient client){
        if(client.player==null||client.world==null||client.getNetworkHandler()==null||activeWorldSessionId==null||!config.observationEnabled())return;
        JsonObject body=new JsonObject();body.addProperty("session_id",activeWorldSessionId);body.addProperty("connected",true);body.addProperty("server",config.actionServer());body.addProperty("observed_at",Instant.now().toString());
        JsonObject self=new JsonObject();self.addProperty("x",client.player.getX());self.addProperty("y",client.player.getY());self.addProperty("z",client.player.getZ());
        self.addProperty("yaw",MathHelper.wrapDegrees(client.player.getYaw()));self.addProperty("pitch",client.player.getPitch());
        Vec3d v=client.player.getVelocity();self.addProperty("vx",v.x);self.addProperty("vy",v.y);self.addProperty("vz",v.z);
        self.addProperty("on_ground",client.player.isOnGround());self.addProperty("health",client.player.getHealth());
        self.addProperty("dimension",client.world.getRegistryKey().getValue().toString());
        ClientActionController.Action forward=new ClientActionController.Action("snapshot","snapshot","walk",1,0,0,0,300,System.currentTimeMillis()+1000,activeWorldSessionId);
        ClientActionController.StepCheck step=ClientActionController.checkStep(client,forward);
        self.addProperty("collision_ahead",step.collisionAhead());self.addProperty("support_ahead",step.supportAhead());
        step.addSummary(self,client.player.isOnGround());body.add("self",self);
        JsonArray visible=new JsonArray();Map<UUID,JsonObject> recognized=new ConcurrentHashMap<>();Vec3d eye=client.player.getEyePos();float yaw=client.player.getYaw();
        ArrayList<JsonObject> candidates=new ArrayList<>();
        for(PlayerEntity entity:client.world.getPlayers()){
            if(entity==client.player||entity.isSpectator()||entity.isInvisibleTo(client.player))continue;
            Vec3d pos=new Vec3d(entity.getX(),entity.getY(),entity.getZ());double distance=Math.sqrt(pos.squaredDistanceTo(new Vec3d(client.player.getX(),client.player.getY(),client.player.getZ())));if(distance>16||distance<0.01)continue;
            Vec3d target=entity.getEyePos();HitResult obstruction=client.world.raycast(new RaycastContext(eye,target,RaycastContext.ShapeType.COLLIDER,RaycastContext.FluidHandling.NONE,client.player));
            boolean lineOfSight=obstruction.getType()==HitResult.Type.MISS||obstruction.getPos().squaredDistanceTo(eye)+0.09>=target.squaredDistanceTo(eye);
            if(!lineOfSight)continue;
            String name=entity.getGameProfile().name();double dx=pos.x-client.player.getX(),dy=pos.y-client.player.getY(),dz=pos.z-client.player.getZ();
            double bearing=RelativeBearing.degrees(dx,dz,yaw);
            JsonObject player=new JsonObject();player.addProperty("uuid",entity.getUuidAsString());player.addProperty("name",name);
            player.addProperty("x",pos.x);player.addProperty("y",pos.y);player.addProperty("z",pos.z);player.addProperty("dx",dx);player.addProperty("dy",dy);player.addProperty("dz",dz);
            player.addProperty("distance",distance);player.addProperty("bearing_degrees",bearing);player.addProperty("line_of_sight",true);
            candidates.add(player);
        }
        candidates.sort(Comparator.comparingDouble(p->p.get("distance").getAsDouble()));
        for(int i=0;i<Math.min(8,candidates.size());i++){JsonObject candidate=candidates.get(i);visible.add(candidate);recognized.put(UUID.fromString(candidate.get("uuid").getAsString()),candidate);}
        nearbyPlayers=Map.copyOf(recognized);body.add("players",visible);
        JsonObject crosshair=new JsonObject();
        if(client.crosshairTarget==null)crosshair.addProperty("type","none");
        else if(client.crosshairTarget.getType()==HitResult.Type.MISS)crosshair.addProperty("type","miss");
        else if(client.crosshairTarget instanceof EntityHitResult hit&&hit.getEntity() instanceof PlayerEntity player){crosshair.addProperty("type","player");crosshair.addProperty("player_uuid",player.getUuidAsString());crosshair.addProperty("player_name",player.getGameProfile().name());crosshair.addProperty("distance",Math.sqrt(player.squaredDistanceTo(client.player)));}
        else if(client.crosshairTarget instanceof EntityHitResult hit){crosshair.addProperty("type","entity");crosshair.addProperty("distance",Math.sqrt(hit.getEntity().squaredDistanceTo(client.player)));}
        else if(client.crosshairTarget instanceof BlockHitResult hit){crosshair.addProperty("type","block");BlockPos pos=hit.getBlockPos();crosshair.addProperty("x",pos.getX());crosshair.addProperty("y",pos.getY());crosshair.addProperty("z",pos.getZ());crosshair.addProperty("block_id",Registries.BLOCK.getId(client.world.getBlockState(pos).getBlock()).toString());}
        else crosshair.addProperty("type","miss");
        body.add("crosshair",crosshair);
        observationIo.execute(()->postObservation(body));
    }

    private void postDisconnectedObservation(String sessionId){
        JsonObject body=new JsonObject();body.addProperty("session_id",sessionId);body.addProperty("connected",false);body.add("server",com.google.gson.JsonNull.INSTANCE);body.addProperty("observed_at",Instant.now().toString());
        observationIo.execute(()->postObservation(body));
    }

    private void postObservation(JsonObject body){
        String sessionId=body.get("session_id").getAsString();
        if(body.get("connected").getAsBoolean()&&!java.util.Objects.equals(activeWorldSessionId,sessionId))return;
        if(!body.get("connected").getAsBoolean()&&java.util.Objects.equals(activeWorldSessionId,sessionId))return;
        try{HttpResponse<String> response=request("POST","/bridge/observation",body.toString());if(response.statusCode()!=200)LOG.warn("World observation rejected with status {}",response.statusCode());}
        catch(Exception error){LOG.warn("Could not publish bounded world observation: {}",error.getClass().getSimpleName());}
    }

    private void pollReplies() {
        try {
            HttpResponse<String> response = request("GET", "/bridge/replies", null);
            if (response.statusCode() != 200) return;
            JsonArray replies = JsonParser.parseString(response.body()).getAsJsonArray();
            for (int i = 0; i < replies.size(); i++) {
                JsonObject reply = replies.get(i).getAsJsonObject();
                String id = reply.get("id").getAsString();
                String text = reply.get("text").getAsString();
                if (text.isBlank() || text.length() > 300 || !queuedReplies.add(id)) continue;
                recentlySpoken.put(normalizeSpeech(text),System.nanoTime());
                MinecraftClient.getInstance().execute(() -> {
                    MinecraftClient client = MinecraftClient.getInstance();
                    if (client.player == null) { queuedReplies.remove(id); return; }
                    client.player.sendMessage(Text.literal("[" + config.characterName() + "] ").formatted(Formatting.AQUA)
                            .append(Text.literal(text).formatted(Formatting.WHITE)), false);
                    io.execute(() -> {
                        try {
                            HttpResponse<String> ack = request("POST", "/bridge/replies/" + id + "/ack", "{}");
                            if (ack.statusCode() != 200) throw new IllegalStateException("ack_status_" + ack.statusCode());
                        }
                        catch (Exception error) { LOG.warn("Could not acknowledge reply: {}", error.getClass().getSimpleName()); }
                        finally { queuedReplies.remove(id); }
                    });
                });
            }
        } catch (Exception error) {
            LOG.warn("Bridge poll failed: {}", error.getClass().getSimpleName());
        }
    }

    private HttpResponse<String> request(String method, String path, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(config.coreUrl() + path))
                .timeout(Duration.ofSeconds(5)).header("Authorization", "Bearer " + config.token())
                .header("Content-Type", "application/json");
        if ("GET".equals(method)) builder.GET(); else builder.POST(HttpRequest.BodyPublishers.ofString(body == null ? "{}" : body));
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
}
