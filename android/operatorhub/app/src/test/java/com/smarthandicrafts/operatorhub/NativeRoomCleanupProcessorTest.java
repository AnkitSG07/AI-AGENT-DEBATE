package com.smarthandicrafts.operatorhub;

import android.app.Application;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = 28, application = Application.class)
public class NativeRoomCleanupProcessorTest {
    private static final long NOW = 1793188800000L;
    private static final String ID = "android_1234567890abcdefghijklmnop", TOKEN = ID + ".abcdefghijklmnopqrstuvwxyz0123456789";
    private static final String CALL = "out_0123456789abcdef0123456789abcdef";
    private static final String REQUEST = "f2f388b0-6d16-4c1e-8e5d-df1698c75e15";
    private static final class Queue implements NativeRoomCleanupProcessor.Queue {
        final Map<String, String> records = new LinkedHashMap<>();
        public List<String> keys() { return new ArrayList<>(records.keySet()); }
        public JSONObject read(String key) throws Exception { return records.containsKey(key) ? new JSONObject(records.get(key)) : null; }
        public void remove(String key, String id) throws Exception { JSONObject old = read(key); if (old != null && id.equals(old.optString("requestId"))) records.remove(key); }
        public void update(String key, String id, JSONObject value) throws Exception { JSONObject old = read(key); if (old != null && id.equals(old.optString("requestId"))) records.put(key, value.toString()); }
    }
    private static final class Device implements NativeRoomCleanupProcessor.Device {
        DeviceLeasePolicy.Credential credential = new DeviceLeasePolicy.Credential(ID, TOKEN, NOW + 1000000, 1);
        int unauthorized;
        public DeviceLeasePolicy.Credential current() { return credential; }
        public void unauthorized(DeviceLeasePolicy.Credential expected, String message) { if (DeviceLeasePolicy.sameIdentity(expected, credential)) unauthorized++; }
        public void problem(DeviceLeasePolicy.Credential expected, String message) { }
    }
    private JSONObject record(String leg, String intent, String transfer) throws Exception {
        return new JSONObject().put("callId", CALL).put("transferId", transfer).put("ownerLegId", leg).put("intent", intent)
            .put("deviceId", ID).put("generation", 1).put("credentialHash", NativeRoomCleanupProcessor.digest(TOKEN))
            .put("requestId", REQUEST).put("outgoingRequestId", "").put("createdAt", NOW).put("attempts", 0);
    }
    private JSONObject status(String owner, String leg, String phase, JSONObject transfer) throws Exception {
        JSONObject call = new JSONObject().put("ownerDeviceId", owner).put("ownerLegId", leg).put("phase", phase).put("version", 7);
        if (transfer != null) call.put("transfer", transfer);
        return new JSONObject().put("ok", true).put("call", call);
    }
    private JSONObject transfer(String id, String state, String target) throws Exception { return new JSONObject().put("id", id).put("status", state).put("toDeviceId", target); }
    @Test public void explicitDeclineNeedsNoFcmRecordAndRejectsOnlyUnownedRing() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("", "decline", "").toString()); List<String> posts = new ArrayList<>();
        boolean pending = new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            if (method.equals("GET")) return status("", "", "ringing", null);
            posts.add(path); return new JSONObject().put("ok",true);
        }).runPass(NOW);
        assertFalse(pending); assertEquals(Collections.singletonList("/calls/" + CALL + "/reject"),posts); assertTrue(q.records.isEmpty());
    }
    @Test public void actualJsonNullOwnerStillMeansAnUnownedRingingCall() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("", "decline", "").toString()); List<String> posts = new ArrayList<>();
        JSONObject call = new JSONObject("{\"ok\":true,\"call\":{\"ownerDeviceId\":null,\"ownerLegId\":null,\"phase\":\"ringing\",\"version\":1}}");
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { if (method.equals("GET")) return call; posts.add(path); return new JSONObject().put("ok",true); }).runPass(NOW);
        assertEquals(Collections.singletonList("/calls/" + CALL + "/reject"),posts);
        assertEquals("",new NativeApi.ApiException(502,"pending",new JSONObject("{\"sessionId\":null}")).sessionId);
    }
    @Test public void declineReceivedAfterAnotherPhoneAnswersNeverEndsTheCustomer() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("", "decline", "").toString()); AtomicInteger writes = new AtomicInteger();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { if (!method.equals("GET")) writes.incrementAndGet(); return status("phone-B", "leg-B", "connected", null); }).runPass(NOW);
        assertEquals(0,writes.get()); assertTrue(q.records.isEmpty());
    }
    @Test public void queuedEndRetainsExactOwnerLegInItsPost() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-A1", "end", "").toString());
        List<JSONObject> posts = new ArrayList<>();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { if (method.equals("POST")) { posts.add(body); return new JSONObject().put("ok", true); } return status(ID,"leg-A1","connected",null); }).runPass(NOW);
        assertEquals(1,posts.size()); assertEquals("leg-A1",posts.get(0).getString("expectedOwnerLegId")); assertEquals(REQUEST,posts.get(0).getString("requestId"));
    }
    @Test public void oldAEndCannotEndTheSameCallTransferredBackToANewLeg() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-A1", "end", "").toString()); AtomicInteger attempts = new AtomicInteger();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            assertEquals("POST",method); assertEquals("leg-A1",body.getString("expectedOwnerLegId")); attempts.incrementAndGet();
            throw new NativeApi.ApiException(409,"owner changed",new JSONObject().put("code","CALL_LEG_CHANGED"));
        }).runPass(NOW);
        // The current server rejects the exact obsolete leg atomically. It must
        // never be refreshed to adopt A2, or retried as an unscoped End.
        assertEquals(1,attempts.get()); assertTrue(q.records.isEmpty());
    }
    @Test public void statusCompletingAfterReenrollmentCannotAuthorizeAWrite() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-A1", "end", "T1").toString()); AtomicInteger writes = new AtomicInteger();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            if (!method.equals("GET")) writes.incrementAndGet();
            d.credential = new DeviceLeasePolicy.Credential(ID,TOKEN,NOW + 1000000,2);
            return status(ID,"leg-A1","connected",null);
        }).runPass(NOW);
        assertEquals(0,writes.get()); assertTrue(q.records.isEmpty()); assertEquals(0,d.unauthorized);
    }
    @Test public void transientFailureSurvivesProcessRestartWithSameRequestId() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-A1", "end", "").toString());
        assertTrue(new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { throw new IOException("offline"); }).runPass(NOW));
        assertEquals(0,d.unauthorized); assertEquals(REQUEST,q.read("q").getString("requestId"));
        Queue restarted = new Queue(); restarted.records.putAll(q.records); List<String> requests = new ArrayList<>();
        assertFalse(new NativeRoomCleanupProcessor(restarted,d,(path,method,body,bearer) -> {
            if (method.equals("GET")) return status(ID,"leg-A1","connected",null);
            requests.add(body.getString("requestId")); return new JSONObject().put("ok",true);
        }).runPass(NOW + 1000));
        assertEquals(Collections.singletonList(REQUEST),requests); assertTrue(restarted.records.isEmpty());
    }
    @Test public void versionConflictRetriesSameLegWithoutAdoptingNewOwnership() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-A1", "end", "").toString()); AtomicInteger posts = new AtomicInteger();
        NativeRoomCleanupProcessor.Requester conflict = (path,method,body,bearer) -> {
            if (method.equals("GET")) return status(ID,"leg-A1","connected",null);
            posts.incrementAndGet(); throw new NativeApi.ApiException(409,"version changed",new JSONObject().put("code","VERSION_CONFLICT"));
        };
        assertTrue(new NativeRoomCleanupProcessor(q,d,conflict).runPass(NOW));
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            assertEquals("POST",method); posts.incrementAndGet();
            assertEquals("leg-A1",body.getString("expectedOwnerLegId")); assertEquals(REQUEST,body.getString("requestId"));
            // Atomic exact-leg End now goes straight to the server. A changed
            // owner rejects it; the client never adopts B's observed leg.
            throw new NativeApi.ApiException(403,"owner changed",new JSONObject().put("code","NOT_CALL_OWNER"));
        }).runPass(NOW + 1000);
        assertEquals(2,posts.get()); assertTrue(q.records.isEmpty());
    }
    @Test public void ambiguousLegacyEndIsDroppedWhenServerRequiresItsOriginalLeg() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("", "end", "").toString());
        assertFalse(new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            if (method.equals("GET")) return status(ID,"leg-A2","connected",null);
            throw new NativeApi.ApiException(409,"leg required",new JSONObject().put("code","CALL_LEG_REQUIRED"));
        }).runPass(NOW)); assertTrue(q.records.isEmpty());
    }
    @Test public void endingTransferTargetDeclinesOnlyItsOwnJoiningInvitation() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("target-leg", "end", "T1").toString()); List<String> posts = new ArrayList<>();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { if (method.equals("GET")) return status("source","source-leg","connected",transfer("T1","connecting",ID)); posts.add(path); return new JSONObject().put("ok",true); }).runPass(NOW);
        assertEquals(Collections.singletonList("/calls/"+CALL+"/transfers/T1/decline"), posts);
    }
    @Test public void targetLocalEndRacingCommitCanEndItsExactNowOwnedLeg() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("target-leg", "end", "T1").toString()); List<String> posts = new ArrayList<>();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { if (method.equals("GET")) return status(ID,"target-leg","connected",transfer("T1","completing",ID)); posts.add(path); return new JSONObject().put("ok",true); }).runPass(NOW);
        assertEquals(Collections.singletonList("/calls/"+CALL+"/end"), posts);
    }
    @Test public void outgoingLostAckCancellationKeepsTheOriginalDialKey() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("", "end", "").put("outgoingRequestId",REQUEST).toString()); List<String> paths = new ArrayList<>();
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { paths.add(path); assertEquals(REQUEST,body.getString("requestId")); return new JSONObject().put("ok",true); }).runPass(NOW);
        assertEquals(Collections.singletonList("/calls/outgoing/"+REQUEST+"/cancel"),paths);
    }
    @Test public void staleUnauthorizedResponseCannotClearANewerCredential() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg", "end", "").toString());
        assertFalse(new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            d.credential = new DeviceLeasePolicy.Credential(ID,TOKEN,NOW + 1000000,2); throw new NativeApi.ApiException(401,"expired");
        }).runPass(NOW)); assertEquals(0,d.unauthorized); assertTrue(q.records.isEmpty());
    }
    @Test public void oldOrExpiredQueueEntriesAreBoundedAndDoNotSendAnything() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg", "end", "").put("createdAt",NOW-NativeRoomCleanupProcessor.MAX_AGE_MS-1).toString());
        new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> { throw new AssertionError("must not send expired cleanup"); }).runPass(NOW); assertTrue(q.records.isEmpty());
    }
    @Test public void exactLegEndPostsImmediatelyWithoutAStatusGet() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-now", "end", "").toString());
        AtomicInteger posts = new AtomicInteger();
        assertFalse(new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            assertEquals("POST",method); assertEquals("/calls/"+CALL+"/end",path);
            assertFalse(body.has("version")); assertEquals("leg-now",body.getString("expectedOwnerLegId"));
            assertEquals(REQUEST,body.getString("requestId")); posts.incrementAndGet(); return new JSONObject().put("ok",true);
        }).runPass(NOW));
        assertEquals(1,posts.get()); assertTrue(q.records.isEmpty());
    }
    @Test public void olderBackendFallsBackToItsVersionedContractWithTheSameLegAndRequestId() throws Exception {
        Queue q = new Queue(); Device d = new Device(); q.records.put("q", record("leg-now", "end", "").toString());
        List<String> methods = new ArrayList<>();
        assertFalse(new NativeRoomCleanupProcessor(q,d,(path,method,body,bearer) -> {
            methods.add(method);
            if (method.equals("GET")) return status(ID,"leg-now","connected",null);
            assertEquals(REQUEST,body.getString("requestId")); assertEquals("leg-now",body.getString("expectedOwnerLegId"));
            if (!body.has("version")) throw new NativeApi.ApiException(409,"version required",new JSONObject().put("code","STALE_CALL_VERSION"));
            assertEquals(7,body.getLong("version")); return new JSONObject().put("ok",true);
        }).runPass(NOW));
        assertEquals(Arrays.asList("POST","GET","POST"),methods); assertTrue(q.records.isEmpty());
    }
}
