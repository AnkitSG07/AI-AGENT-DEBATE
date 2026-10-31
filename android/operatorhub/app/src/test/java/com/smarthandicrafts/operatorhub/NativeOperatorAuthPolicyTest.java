package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeOperatorAuthPolicyTest {
    private static final String QUERY = "?origin=https%3A%2F%2Fwww.smarthandicrafts.com&state=0123456789abcdef0123456789abcdef";
    private static final String URL = NativeOperatorAuthPolicy.ORIGIN + "/operator-auth" + QUERY;
    @Test public void exactProfilePageWithHubAndNonceIsAllowed() {
        assertTrue(NativeOperatorAuthPolicy.allowedPage(URL));
        assertTrue(NativeOperatorAuthPolicy.allowedPage(NativeOperatorAuthPolicy.ORIGIN + "/operator-auth.html" + QUERY));
        assertTrue(NativeOperatorAuthPolicy.allowedResource(URL,"GET",true));
    }
    @Test public void wrongOriginOrNestedAuthorityIsDenied() {
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("https:","http:")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("onrender.com/","onrender.com.evil.test/")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("onrender.com/","onrender.com@evil.test/")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("onrender.com/","onrender.com:443/")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("www.smarthandicrafts.com","evil.test")));
    }
    @Test public void pathAliasesTraversalAndFragmentsAreDenied() {
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("/operator-auth","//operator-auth")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("/operator-auth","/else/../operator-auth")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("/operator-auth","/%6fperator-auth")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"#fragment"));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("/operator-auth","\\operator-auth")));
    }
    @Test public void duplicateExtraEmptyAndMalformedQueryFieldsAreDenied() {
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"&state=0123456789abcdef0123456789abcdef"));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"&origin=https%3A%2F%2Fwww.smarthandicrafts.com"));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"&redirect=https://evil.test"));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"&"));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("origin=", "%6frigin=")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("state=0123456789abcdef0123456789abcdef", "state=%XX")));
    }
    @Test public void nonceLengthAndCharactersAreBounded() {
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("0123456789abcdef0123456789abcdef","short")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("0123456789abcdef0123456789abcdef","x".repeat(129))));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL.replace("0123456789abcdef0123456789abcdef","x".repeat(31)+"%20")));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(URL+"\n"));
    }
    @Test public void onlyExactSameOriginProfilePostResourcesAreAllowed() {
        assertTrue(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/profile-login","POST",false));
        assertTrue(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/operator-browser-auth/token","POST",false));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/profile-login","GET",false));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/profile-login?x=1","POST",false));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/profile-login","POST",true));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(NativeOperatorAuthPolicy.ORIGIN+"/api/zoho-mail/send","POST",false));
        assertFalse(NativeOperatorAuthPolicy.allowedResource("https://evil.test/api/profile-login","POST",false));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(URL,"GET",false));
    }
    @Test public void signedDocumentViewAndDownloadCanLeaveAsUserLinks() {
        String link=NativeOperatorAuthPolicy.ORIGIN+"/api/odoo-documents/view/17?share=shd1.c3ludGhldGlj."+"a".repeat(43);
        assertTrue(NativeOperatorAuthPolicy.allowedDocumentLink(link));
        assertTrue(NativeOperatorAuthPolicy.allowedDocumentLink(link.replace("/view/","/download/")));
        assertFalse(NativeOperatorAuthPolicy.allowedResource(link,"GET",true));
        assertFalse(NativeOperatorAuthPolicy.allowedPage(link));
    }
    @Test public void documentNavigationCannotGrantJsonApiOrUnsignedAccess() {
        String link=NativeOperatorAuthPolicy.ORIGIN+"/api/odoo-documents/view/17?share=shd1.c3ludGhldGlj."+"a".repeat(43);
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link.replace("/view/","/file/")));
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link.split("\\?")[0]));
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link+"&redirect=https://evil.test"));
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link+"#fragment"));
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link.replace("onrender.com/","onrender.com.evil.test/")));
        assertFalse(NativeOperatorAuthPolicy.allowedDocumentLink(link.replace("/17?","/../17?")));
    }
}
