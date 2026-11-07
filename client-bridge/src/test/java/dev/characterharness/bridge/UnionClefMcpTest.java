package dev.characterharness.bridge;

import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class UnionClefMcpTest {
    @Test void endpointRejectsRemoteRedirectTargetsAndCredentialUrls(){
        assertEquals(25350,UnionClefMcp.endpoint("http://127.0.0.1:25350/mcp").getPort());
        for(String url:new String[]{"http://example.org:25350/mcp","https://localhost:25350/mcp","http://localhost/mcp","http://user@localhost:25350/mcp","http://localhost:25350/mcp?q=x","http://localhost:25350/mcp#token","http://localhost:25350/"})assertThrows(IllegalArgumentException.class,()->UnionClefMcp.endpoint(url));
    }
    @Test void authenticatedMcpEnvelopeAndAllowedToolsAreChecked()throws Exception{
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);AtomicInteger calls=new AtomicInteger();
        String token="a".repeat(40);
        server.createContext("/mcp",ex->{try{
            assertEquals("Bearer "+token,ex.getRequestHeaders().getFirst("Authorization"));
            JsonObject req=JsonParser.parseString(new String(ex.getRequestBody().readAllBytes(),StandardCharsets.UTF_8)).getAsJsonObject();calls.incrementAndGet();
            JsonObject result=new JsonObject();
            if("initialize".equals(req.get("method").getAsString())){JsonObject info=new JsonObject();info.addProperty("name","unionclef");result.add("serverInfo",info);}
            else {JsonObject c=new JsonObject();c.addProperty("type","text");c.addProperty("text","{\"ok\":true,\"busy\":false}");JsonArray content=new JsonArray();content.add(c);result.add("content",content);result.addProperty("isError",false);}
            JsonObject out=new JsonObject();out.addProperty("jsonrpc","2.0");out.add("id",req.get("id"));out.add("result",result);byte[] bytes=out.toString().getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type","application/json");ex.sendResponseHeaders(200,bytes.length);ex.getResponseBody().write(bytes);
        }finally{ex.close();}});server.start();
        try{var client=new UnionClefMcp("http://127.0.0.1:"+server.getAddress().getPort()+"/mcp",token);client.initialize();assertFalse(client.call("pathStatus",new JsonObject()).get("busy").getAsBoolean());
            assertThrows(IllegalArgumentException.class,()->client.call("ExecuteCommand",new JsonObject()));assertEquals(2,calls.get());
        }finally{server.stop(0);}
    }
    @Test void unresponsiveServerCannotHoldTheNavigationWorker()throws Exception{
        var release=new java.util.concurrent.CountDownLatch(1);HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/mcp",ex->{try{release.await(5,java.util.concurrent.TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}finally{ex.close();}});server.start();
        try{var client=new UnionClefMcp("http://127.0.0.1:"+server.getAddress().getPort()+"/mcp","c".repeat(40));assertTimeoutPreemptively(java.time.Duration.ofMillis(2500),()->assertThrows(Exception.class,client::initialize));}finally{release.countDown();server.stop(0);}
    }
    @Test void oversizedResponsesAndRedirectsFailClosed()throws Exception{
        for(int status:new int[]{200,302}){
            HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/mcp",ex->{try{ex.getRequestBody().readAllBytes();ex.getResponseHeaders().set("Location","http://127.0.0.1:1/steal");byte[] bytes="x".repeat(70000).getBytes(StandardCharsets.UTF_8);ex.sendResponseHeaders(status,bytes.length);ex.getResponseBody().write(bytes);}finally{ex.close();}});server.start();
            try{var client=new UnionClefMcp("http://127.0.0.1:"+server.getAddress().getPort()+"/mcp","b".repeat(40));assertThrows(Exception.class,client::initialize);}finally{server.stop(0);}
        }
    }
}
