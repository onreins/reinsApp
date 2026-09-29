/**
 * "Buy USDC with card" for the app's pages: Circle's hosted onramp widget in a
 * sheet, paying into the person's own wallet. Needs /vendor/onramp-kit.js
 * (window.CircleOnramp) loaded first.
 *
 * The widget's events only drive the words on screen: a tab can close before
 * "settled" arrives even though the purchase completes. Whether the USDC has
 * landed is read from the wallet's balance on chain.
 */
window.ReinsOnramp = (function () {
  "use strict";
  var statusP = null, dialog = null, root = null, widget = null, poll = null;
  var X = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  // iOS Safari can block an embedded checkout's own storage (identity checks);
  // Circle recommends a popup there, which must open straight from a tap.
  var ua = navigator.userAgent;
  var iosSafari = /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4); };

  function status() {
    statusP = statusP || fetch("/api/onramp/status").then(function (r) { return r.json(); }).catch(function () { return { enabled: false }; });
    return statusP;
  }
  function usdcOf(address) {
    return fetch("/api/usdc/" + address)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j ? j.usdc : null; })
      .catch(function () { return null; });
  }
  async function session(address) {
    var r = await fetch("/api/onramp/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: address }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || "Couldn't start the checkout. Try again.");
    return j;
  }

  function build() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "onramp";
    dialog.setAttribute("aria-labelledby", "onramp-h");
    dialog.innerHTML =
      '<div class="onramp-bar"><b id="onramp-h">Buy USDC</b><button type="button" class="onramp-x" aria-label="Close">' + X + "</button></div>" +
      '<p class="onramp-note" role="status" aria-live="polite"></p>' +
      '<div class="onramp-act"></div>' +
      '<div class="onramp-root"></div>' +
      '<p class="onramp-foot">Checkout by Circle. Card details and identity checks stay with Circle, never with Reins.</p>';
    document.body.appendChild(dialog);
    root = dialog.querySelector(".onramp-root");
    dialog.querySelector(".onramp-x").addEventListener("click", close);
    dialog.addEventListener("close", teardown);
  }
  function note(text, cls) {
    var p = dialog.querySelector(".onramp-note");
    p.className = "onramp-note" + (cls ? " " + cls : "");
    p.textContent = text;
  }
  function action(label, fn) {
    var box = dialog.querySelector(".onramp-act");
    box.innerHTML = "";
    if (!label) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn-white wide";
    b.textContent = label;
    b.addEventListener("click", fn);
    box.appendChild(b);
  }
  function teardown() {
    if (widget) { try { widget.close(); } catch (e) { /* already gone */ } widget = null; }
    clearInterval(poll);
    poll = null;
    if (root) root.innerHTML = "";
    if (dialog) { dialog.classList.remove("live"); action(null); }
  }
  function close() { if (dialog && dialog.open) dialog.close(); }

  // Watch the wallet until the purchase shows up in it (or give up quietly).
  function watch(address, before, onFunded) {
    if (poll) return;
    var t0 = Date.now();
    poll = setInterval(async function () {
      var now = await usdcOf(address);
      if (now != null && before != null && now > before + 0.000001) {
        clearInterval(poll);
        note("Received " + (now - before).toFixed(2) + " USDC. Your wallet now holds " + now.toFixed(2) + ".", "ok");
        if (onFunded) onFunded(now);
        setTimeout(close, 2500);
      } else if (Date.now() - t0 > 10 * 60000) {
        clearInterval(poll);
        note("Still waiting for the USDC. It can take a few minutes, and your balance here updates by itself.");
      }
    }, 5000);
  }

  /** Open the checkout for `address`; `onFunded(newBalance)` runs once the USDC arrives. */
  async function open(o) {
    var st = await status();
    if (!st.enabled || !window.CircleOnramp) return;
    build();
    teardown();
    dialog.showModal();
    note("Preparing a secure checkout from Circle…");
    var before = await usdcOf(o.address);
    var s;
    try { s = await session(o.address); } catch (err) { note(err.message, "err"); return; }

    var kit = window.CircleOnramp.createOnrampKit({ widgetBaseUrl: st.widgetBaseUrl });
    var events = {
      session: s,
      onInitializationSuccess: function () { note("Pay with a debit card, Apple Pay or Google Pay. The USDC goes to your wallet " + short(o.address) + "."); },
      onInitializationError: function () { note("The checkout couldn't load. Close this and try again in a moment.", "err"); },
      onDepositSubmitted: function () { note("Payment sent. Waiting for the USDC to reach your wallet…"); watch(o.address, before, o.onFunded); },
      onDepositSettled: function () { watch(o.address, before, o.onFunded); },
      onDepositNotCompleted: function (env) {
        if (env && env.code === "CANCELED_BY_CUSTOMER") close();
        else note("The purchase didn't complete. You can try again.", "err");
      },
      onSessionExpired: function () { note("This checkout expired or couldn't be verified. Close it and start a new one.", "err"); },
    };
    var inline = function () {
      dialog.classList.add("live");
      widget = kit.mountIframe(Object.assign({ container: root }, events));
    };
    if (!iosSafari) return inline();
    note("Your checkout is ready.");
    action("Open Circle checkout", function () {
      var r = kit.openWindow(events);
      action(null);
      if (r.status === "blocked") return inline();
      widget = r.widget;
      note("Finish in the Circle window. This page updates when the USDC arrives.");
    });
  }

  return { status: status, usdcOf: usdcOf, open: open };
})();
