package dev.characterharness.bridge;

import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.Flow;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/** Fixed local MCP destination; token and upstream instructions never enter model context. */
final class UnionClefMcp {
    private final URI endpoint;
    private final String token;
    private final HttpClient http;
    private final AtomicLong ids=new AtomicLong();
    UnionClefMcp(String endpoint,String token) {
        this.endpoint=endpoint(endpoint);
        if(token==null||!token.matches("[A-Za-z0-9_-]{32,128}"))throw new IllegalArgumentException("Invalid UnionClef token");
        this.token=token;
        http=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofMillis(500)).build();
    }
    static URI endpoint(String value){
        URI u=URI.create(value);
        if(!"http".equals(u.getScheme())||!Set.of("127.0.0.1","localhost").contains(u.getHost())||u.getPort()<1||u.getPort()>65535
            ||u.getRawUserInfo()!=null||!"/mcp".equals(u.getRawPath())||u.getRawQuery()!=null||u.getRawFragment()!=null)
            throw new IllegalArgumentException("UnionClef MCP must be loopback HTTP /mcp with an explicit port");
        return u;
    }
    private JsonObject rpc(String method,JsonObject params) throws Exception {
        long id=ids.incrementAndGet();JsonObject request=new JsonObject();request.addProperty("jsonrpc","2.0");request.addProperty("id",id);
        request.addProperty("method",method);request.add("params",params);
        var req=HttpRequest.newBuilder(endpoint).timeout(Duration.ofMillis(1200)).header("Authorization","Bearer "+token)
            .header("Content-Type","application/json").header("Accept","application/json")
            .POST(HttpRequest.BodyPublishers.ofString(request.toString())).build();
        var pending=http.sendAsync(req,info->new BoundedBody());
        HttpResponse<byte[]> response;
        try{response=pending.get(1500,TimeUnit.MILLISECONDS);}
        catch(Exception e){pending.cancel(true);throw e;}
        if(response.statusCode()!=200)throw new IllegalStateException("unionclef_unavailable");
        JsonObject envelope=JsonParser.parseString(new String(response.body(),StandardCharsets.UTF_8)).getAsJsonObject();
        if(!envelope.has("id")||envelope.get("id").getAsLong()!=id||envelope.has("error")||!"2.0".equals(envelope.get("jsonrpc").getAsString()))throw new IllegalStateException("Invalid MCP envelope");
        return envelope.getAsJsonObject("result");
    }
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();
        private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody(){return result;}
        public void onSubscribe(Flow.Subscription s){subscription=s;s.request(1);}
        public void onNext(List<ByteBuffer> chunks){
            for(ByteBuffer chunk:chunks){
                if(chunk.remaining()>65536-bytes.size()){subscription.cancel();result.completeExceptionally(new IllegalStateException("MCP response too large"));return;}
                byte[] part=new byte[chunk.remaining()];chunk.get(part);bytes.writeBytes(part);
            }
            subscription.request(1);
        }
        public void onError(Throwable t){result.completeExceptionally(t);}
        public void onComplete(){result.complete(bytes.toByteArray());}
    }
    void initialize() throws Exception {
        JsonObject p=new JsonObject();p.addProperty("protocolVersion","2024-11-05");p.add("capabilities",new JsonObject());
        JsonObject info=new JsonObject();info.addProperty("name","character-harness");info.addProperty("version","0.2.0");p.add("clientInfo",info);
        JsonObject result=rpc("initialize",p);
        if(!"unionclef".equals(result.getAsJsonObject("serverInfo").get("name").getAsString()))throw new IllegalStateException("Unexpected MCP server");
    }
    JsonObject call(String name,JsonObject args) throws Exception {
        if(!Set.of("gotoXYZ","pathStatus","stopPathing").contains(name))throw new IllegalArgumentException("MCP tool denied");
        JsonObject p=new JsonObject();p.addProperty("name",name);p.add("arguments",args);JsonObject result=rpc("tools/call",p);
        if(result.has("isError")&&result.get("isError").getAsBoolean())throw new IllegalStateException("MCP tool failed");
        var content=result.getAsJsonArray("content");
        if(content==null||content.size()!=1||!"text".equals(content.get(0).getAsJsonObject().get("type").getAsString()))throw new IllegalStateException("Invalid MCP content");
        JsonObject data=JsonParser.parseString(content.get(0).getAsJsonObject().get("text").getAsString()).getAsJsonObject();
        if(!data.has("ok")||!data.get("ok").getAsBoolean())throw new IllegalStateException("MCP action rejected");return data;
    }
}
