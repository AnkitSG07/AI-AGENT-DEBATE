/* SH Chat authentication presentation. The existing Odoo forms remain untouched. */
(() => {
  "use strict";
  if (window.top !== window || location.origin !== "https://www.smarthandicrafts.com") return;
  const auth = /^\/web\/(?:login(?:\/[^?#]*)?|reset_password|signup)\/?$/.test(location.pathname);
  if (!auth) return;
  if (window.__shAuthPresentationR9) return;
  window.__shAuthPresentationR9 = true;
  const css = __SH_AUTH_CSS__;
  const logo = __SH_BRAND_LOGO__;
  const isReset = location.pathname.startsWith("/web/reset_password");
  const isSignup = location.pathname.startsWith("/web/signup");
  const isVerification = location.pathname.startsWith("/web/login/");
  function apply() {
    if (!document.documentElement) return;
    document.documentElement.classList.add("sh-native-auth");
    if (!document.getElementById("sh-native-auth-css")) {
      const style = document.createElement("style");
      style.id = "sh-native-auth-css"; style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
    const main = document.querySelector("main");
    if (!main || document.getElementById("sh-native-auth-intro")) return;
    const intro = document.createElement("div"); intro.id = "sh-native-auth-intro";
    const mark = document.createElement("img"); mark.src = logo; mark.alt = "Smart Handicrafts"; mark.width = 76; mark.height = 76;
    const brand = document.createElement("p"); brand.className = "sh-auth-brand"; brand.textContent = "Smart Handicrafts®";
    const title = document.createElement("h1");
    title.textContent = isReset ? "Reset your password" : isSignup ? "Your Odoo account" : isVerification ? "Verify your sign-in" : "Welcome to SH Chat";
    const caption = document.createElement("p"); caption.className = "sh-auth-caption";
    caption.textContent = isReset ? "Follow Odoo’s instructions to recover your account." : isSignup ? "Continue with your Smart Handicrafts workspace account." : isVerification ? "Complete the verification requested by Odoo." : "Sign in with your Odoo account to continue.";
    intro.append(mark, brand, title, caption); main.prepend(intro);
    const footer = document.createElement("p"); footer.id = "sh-native-auth-note";
    footer.textContent = "Your sign-in is handled securely by Smart Handicrafts’ Odoo website.";
    main.appendChild(footer);
  }
  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
})();
