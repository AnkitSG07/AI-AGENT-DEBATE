package com.smarthandicrafts.operatorhub;

import org.json.JSONObject;
import java.text.DateFormat;
import java.util.Date;

/** Exact-number projection of provider permission; message delivery never grants consent. */
public final class NativeCallPermissionState {
    public final String to, status, requestId, requestState, requestCode;
    public final boolean canCall, canRequest;
    public final long expiresAtMs, checkedAtMs;
    private NativeCallPermissionState(String to,String status,String requestId,String requestState,String requestCode,
            boolean canCall,boolean canRequest,long expiresAtMs,long checkedAtMs) {
        this.to=to;this.status=status;this.requestId=requestId;this.requestState=requestState;this.requestCode=requestCode;
        this.canCall=canCall;this.canRequest=canRequest;this.expiresAtMs=expiresAtMs;this.checkedAtMs=checkedAtMs;
    }
    public static String normalize(String entered) {
        String value=entered==null?"":entered.trim();
        String number=value.matches("\\+?[1-9][0-9 ()-]*")?value.replaceAll("[^0-9]",""):"";
        return NativeRoomPolicy.validPhone(number)?number:"";
    }
    public static boolean validRequestId(String value) { return value!=null&&value.matches("[A-Za-z0-9_-]{8,120}"); }
    public static NativeCallPermissionState parse(JSONObject result,String expectedTo,String expectedRequestId,long now) throws Exception {
        if (!NativeRoomPolicy.validPhone(expectedTo)||!Boolean.TRUE.equals(result.opt("ok"))||!expectedTo.equals(result.optString("to")))
            throw new Exception("Permission response did not match this number.");
        JSONObject permission=result.getJSONObject("permission");
        String status=permission.getString("status");
        if (!status.matches("unknown|no_permission|temporary|permanent|expired")) throw new Exception("Unknown permission status.");
        if (!(permission.get("canCall") instanceof Boolean)||!(permission.get("canRequest") instanceof Boolean))
            throw new Exception("Unconfirmed permission flags.");
        long checked=permission.getLong("checkedAtMs");
        if (checked<=0||checked>now+30000) throw new Exception("Invalid permission check time.");
        long expiry=permission.isNull("expiresAtMs")?0:permission.getLong("expiresAtMs");
        if ("temporary".equals(status)&&expiry<=0) throw new Exception("Temporary permission has no expiry.");
        JSONObject request=result.optJSONObject("request");String id="",state="",code="";
        if (request!=null) {
            id=request.getString("requestId");state=request.getString("state");code=request.optString("code","");
            if (!validRequestId(id)||!state.matches("sending|sent|uncertain|blocked")
                ||(expectedRequestId!=null&&!expectedRequestId.isEmpty()&&!expectedRequestId.equals(id)))
                throw new Exception("Permission request did not match this operation.");
        }
        boolean allowed=permission.getBoolean("canCall")&&("permanent".equals(status)||("temporary".equals(status)&&expiry>now));
        boolean requestAllowed=permission.getBoolean("canRequest")&&("no_permission".equals(status)||"expired".equals(status))&&!allowed&&!"sending".equals(state)&&!"uncertain".equals(state);
        return new NativeCallPermissionState(expectedTo,status,id,state,code,allowed,requestAllowed,expiry,checked);
    }
    public static String blockedMessage(String code,String number) {
        if ("CALL_PERMISSION_WINDOW_CLOSED".equals(code))
            return "The customer messaging window is closed for "+number+". No permission request was sent. Ask the customer to message your business, then check permission before requesting again.";
        if ("CALL_PERMISSION_UNAVAILABLE".equals(code)||"CALL_PERMISSION_STATUS_UNAVAILABLE".equals(code))
            return "Call permission is unavailable for "+number+" right now. No permission request was sent. Use Check permission before trying again.";
        return "The permission request for "+number+" was blocked. No permission request was sent. Use Check permission before requesting again.";
    }
    public String message() {
        String number="+"+to;
        if (canCall) return "temporary".equals(status)
            ? "Calls allowed for "+number+" until "+DateFormat.getDateTimeInstance(DateFormat.MEDIUM,DateFormat.SHORT).format(new Date(expiresAtMs))+". Tap Call when ready."
            : "Calls allowed for "+number+". Tap Call when ready.";
        if ("uncertain".equals(requestState)||"sending".equals(requestState))
            return "Permission request delivery is unconfirmed for "+number+". Use Check permission; this app will not resend it automatically.";
        if ("sent".equals(requestState)) return "Permission request sent to "+number+". Call permission is not granted yet. A sent message is not permission.";
        if ("blocked".equals(requestState)) return blockedMessage(requestCode,number);
        if ("expired".equals(status)||("temporary".equals(status)&&expiresAtMs<=System.currentTimeMillis())) return "Call permission for "+number+" has expired. A new customer approval is needed.";
        if ("temporary".equals(status)||"permanent".equals(status)) return "Calling +"+to+" is currently unavailable. Check permission again before calling.";
        if ("no_permission".equals(status)) return "The customer must allow calls to "+number+" before you can call.";
        return "Call permission for "+number+" has not been confirmed. Check permission or explicitly request it.";
    }
}
