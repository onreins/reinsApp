/* The Agents page's top half: the rule check replaying the testnet run, the
   featured strategy cards, the on-chain activity feed and the hero's totals.
   Loaded after ui.js; index.html hands it the data it already fetches. */
window.ReinsHome = (function () {
  "use strict";
  var U = window.ReinsUI, esc = U.esc;
  var still = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var TX = "https://explorer.testnet.arc.io/tx/";

  // ------------------------------------------------------------ rule check
  // A mandate's checks in the order a trade meets them, and six real
  // transactions from docs/live-run/TESTNET-RUN.md: one fill, five refusals.
  var CHECKS = ["Signed by its agent", "Not frozen", "Asset is allowed", "Under the $2 cap", "Within 1% of the oracle", "Stays above the loss floor"];
  var RUN = [
    { ask: "Buy $0.50 of EURC", stranger: false, fail: -1, vals: ["agent key", "live", "EURC", "$0.50", "0.45% off", "$2.00 ≥ $1.80"],
      head: "Filled on-chain", body: "Bought 0.4374 EURC, 0.45% from the oracle price.", tx: "0xe95e9c7d667af65799cbd3303a7cdc33ab64258fd6c5244a60f6f40782fb86ec" },
    { ask: "Buy $2.50 of EURC", stranger: false, fail: 3, vals: ["agent key", "live", "EURC", "$2.50"],
      head: "Refused: TradeTooLarge", body: "$2.50 is over the $2 cap set when the agent was created.", tx: "0x685d4a906aefb333041798a22bcef2b95c100d60970307407e860225a486cc5e" },
    { ask: "Buy $1 of USYC", stranger: false, fail: 2, vals: ["agent key", "live", "USYC"],
      head: "Refused: AssetNotAllowed", body: "USYC is a real token this agent was never granted.", tx: "0x5c50decbafeee6dcf4ddb98ab6567f8abc0e383d29a9705fd97d10db2305dc5d" },
    { ask: "Buy $1 of EURC", stranger: false, fail: 4, vals: ["agent key", "live", "EURC", "$1.00", "over 1%"],
      head: "Refused: InsufficientOutput", body: "The pool was too thin to fill it within 1% of the oracle.", tx: "0x0ae7cd48e39945f69f843857e053de0380ea8626b965633a767acb86fb00e6fa" },
    { ask: "Buy $0.50 of EURC", stranger: true, fail: 0, vals: ["stranger"],
      head: "Refused: NotAgent", body: "A key that isn’t this agent’s can’t touch its money.", tx: "0x48b35a907b745397ceeaee5343d0ce56c4e30f36071cf5caa1ae85cec560a752" },
    { ask: "Buy $0.50 of EURC", stranger: false, fail: 1, vals: ["agent key", "frozen"],
      head: "Refused: IsFrozen", body: "It fell through its floor, and a stranger froze it.", tx: "0xddad294e5abc6b6c75ab72c951c43dc56c9889796abec695942071af5090944f" },
  ];
  var TICK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 6.2 2.3 2.3 4.7-4.9"/></svg>';
  var CROSS = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3 3 6 6M9 3 3 9"/></svg>';
  var STEP_MS = 420;
  var HOLD_MS = 3600;
  var IDLE_MS = 400;

  var lastStep = function (s) { return s.fail >= 0 ? s.fail : CHECKS.length - 1; };

  function checkClass(s, j, step, done) {
    if (j < step) return "ok";
    if (j === step) return done ? (j === s.fail ? "no" : "ok") : "run";
    return done && j > lastStep(s) ? "skip" : "";
  }

  function ruleCheck(root) {
    var $ = function (id) { return root.querySelector("#" + id); };
    var cur = 0, step = 0, done = false, timer = null, held = false, paused = false;
    $("rc-ic").outerHTML = U.icon("shield");
    var pause = $("rc-pause");
    if (still) pause.hidden = true; // nothing moves on its own
    pause.addEventListener("click", function () {
      paused = !paused;
      pause.setAttribute("aria-pressed", String(paused));
      pause.textContent = paused ? "Play" : "Pause";
    });
    $("rc-dots").innerHTML = RUN.map(function (s, i) {
      return '<button type="button" data-i="' + i + '" aria-label="Show: ' + esc(s.head) + '"></button>';
    }).join("");
    $("rc-dots").addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (b) play(Number(b.getAttribute("data-i")));
    });
    // Stay on the current answer while someone is reading or tabbing through
    // it. This only delays the move to the next scenario: a scenario that has
    // started always finishes, so a clicked dot shows its result.
    root.addEventListener("mouseenter", function () { held = true; });
    root.addEventListener("mouseleave", function () { held = false; });
    root.addEventListener("focusin", function () { held = true; });
    root.addEventListener("focusout", function () { held = false; });

    function later(fn, ms, waitForReader) {
      clearTimeout(timer);
      timer = setTimeout(function wait() {
        if (waitForReader && (held || paused || document.hidden)) { timer = setTimeout(wait, IDLE_MS); return; }
        fn();
      }, ms);
    }
    function paint() {
      var s = RUN[cur];
      $("rc-ask").textContent = s.ask;
      $("rc-who").textContent = s.stranger ? "signed by a stranger’s key" : "signed by its agent";
      $("rc-who").className = s.stranger ? "bad" : "";
      $("rc-list").innerHTML = CHECKS.map(function (c, j) {
        var cls = checkClass(s, j, step, done);
        return '<li class="' + cls + '"><span class="mk">' + (cls === "no" ? CROSS : TICK) + "</span><span>" + esc(c) +
          '</span><span class="v">' + esc(s.vals[j] || "") + "</span></li>";
      }).join("");
      var out = $("rc-out");
      out.className = "hm-out" + (done ? " show " + (s.fail < 0 ? "ok" : "no") : "");
      out.innerHTML = done
        ? "<b>" + esc(s.head) + "</b><p>" + esc(s.body) + '</p><a href="' + TX + s.tx + '" target="_blank" rel="noopener">' +
          s.tx.slice(0, 10) + "… on the explorer " + U.icon("ext") + "</a>"
        : '<p class="muted">Checking…</p>';
      root.querySelectorAll("#rc-dots button").forEach(function (b, i) { b.setAttribute("aria-pressed", String(i === cur)); });
    }
    function advance() {
      if (step < lastStep(RUN[cur])) { step += 1; paint(); later(advance, STEP_MS, false); return; }
      done = true;
      paint();
      later(function () { play((cur + 1) % RUN.length); }, HOLD_MS, true);
    }
    function play(i) {
      cur = i;
      step = 0;
      done = false;
      if (still) { // no animation: show the whole answer, and let the dots step through
        clearTimeout(timer);
        step = lastStep(RUN[cur]);
        done = true;
        paint();
        return;
      }
      paint();
      later(advance, STEP_MS, false);
    }
    play(0);
  }

  // ------------------------------------------------------- featured cards
  var T2024 = Date.UTC(2024, 0, 1) / 1000;
  var FEATURED = 3;

  function featured(el, strats) {
    var top = (strats || []).slice(0, FEATURED);
    if (!top.length) {
      el.innerHTML = '<p class="hm-empty"><b>Strategy templates couldn’t load</b>Reload the page to try again.</p>';
      return;
    }
    el.innerHTML = top.map(function (s) {
      var st = s.stats, valid = s.status === "validated";
      var pts = U.curvePoints(s.curve.filter(function (p) { return p.t >= T2024; }));
      return '<a class="hm-feat" href="/strategy.html?s=' + encodeURIComponent(s.id) + '">' +
        '<span class="t">' + U.coins(s.universe, "sm") + "<b>" + esc(s.name) + "</b>" +
        '<span class="tagp' + (valid ? " ok" : "") + '">' + (valid ? "Validated" : "Candidate") + "</span></span>" +
        '<span class="big ' + U.dirOf(st.cagr_since_2024 * 100) + '">' + U.pct(st.cagr_since_2024 * 100, 0) + "</span>" +
        '<span class="lbl">Annual return since 2024, backtested</span>' +
        '<span class="ch">' + U.areaSvg(pts, { smooth: true }) + "</span>" +
        '<span class="ft"><span>Worst drop <b>' + U.pct(st.max_drawdown * 100, 0) + "</b></span><span>" + U.coinCount(s.universe) + " coins</span></span></a>";
    }).join("");
  }

  // -------------------------------------------------------- activity feed
  var ZERO = "0x0000000000000000000000000000000000000000";
  var KIND = {
    Traded: ["trade", "strategies"], Frozen: ["stop", "freeze"], Unfrozen: ["", "shield"],
    Deposited: ["money", "deposit"], Withdrawn: ["money", "withdraw"], AssetRemoved: ["money", "withdraw"],
    AgentChanged: ["", "agent"], Created: ["new", "create"],
  };
  var MINUTE = 60, HOUR = 3600, DAY = 86400, MONTH = 30 * DAY;

  function amount(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 4 }); }
  function ago(t) {
    if (!t) return "";
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < MINUTE) return "just now";
    if (s < HOUR) return Math.floor(s / MINUTE) + "m ago";
    if (s < DAY) return Math.floor(s / HOUR) + "h ago";
    if (s < MONTH) return Math.floor(s / DAY) + "d ago";
    return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function sentence(e) {
    var who = '<a href="/mandate.html?a=' + esc(e.mandate) + '">' + esc(e.name || "An agent") + "</a>";
    var sum = function (x) { return "<b>" + amount(x.amount) + " " + esc(x.symbol) + "</b>"; };
    switch (e.event) {
      case "Traded": return who + " swapped " + amount(e.sold.amount) + " " + esc(e.sold.symbol) + " for " + sum(e.bought);
      case "Frozen": return who + " was <b>frozen at its floor</b>, " + U.money(e.equityUsd) + " under " + U.money(e.floorUsd);
      case "Unfrozen": return who + " was resumed by its owner";
      case "Deposited": return "Owner deposited " + sum(e) + " into " + who;
      case "Withdrawn": return "Owner withdrew " + sum(e) + " from " + who;
      case "AssetRemoved": return "Owner pulled " + sum(e) + " out of " + who;
      case "AgentChanged": return String(e.agent).toLowerCase() === ZERO ? who + "’s agent key was <b>revoked</b>" : who + " got a new agent key";
      case "Created": return who + " was created";
      default: return who + " " + esc(e.event);
    }
  }
  var idOf = function (e) { return (e.tx || "created") + ":" + e.event + ":" + e.mandate; };
  var seen = null; // ids already on screen, so only new arrivals animate

  function activity(el, d) {
    var events = d.events || [];
    if (!events.length) {
      el.innerHTML = '<li class="hm-empty"><b>Nothing on-chain yet</b>Trades, deposits and freezes appear here as they land.</li>';
      return;
    }
    el.innerHTML = events.map(function (e) {
      var k = KIND[e.event] || ["", "info"];
      var when = e.t ? new Date(e.t * 1000) : null;
      var link = e.tx ? '<a href="' + esc(d.explorer) + "/tx/" + esc(e.tx) + '" target="_blank" rel="noopener">tx ' + U.icon("ext") + "</a>" : "";
      return '<li class="hm-ev ' + k[0] + (seen && !seen[idOf(e)] ? " fresh" : "") + '"><span class="ei">' + U.icon(k[1]) + "</span>" +
        "<div><p>" + sentence(e) + '</p><p class="sub">' +
        (when ? '<time datetime="' + when.toISOString() + '" title="' + esc(when.toLocaleString()) + '">' + ago(e.t) + "</time>" : "") +
        link + "</p></div></li>";
    }).join("");
    seen = {};
    events.forEach(function (e) { seen[idOf(e)] = true; });
  }

  // ------------------------------------------------------------ count-up
  var COUNT_MS = 900;
  // The final number is written first, so a tab that never paints a frame
  // (hidden, or a background pane) still reads right.
  function countUp(el, to, fmt) {
    if (to === null || to === undefined) { el.textContent = "—"; return; } // unknown, not zero
    var first = !el.hasAttribute("data-n");
    el.setAttribute("data-n", String(to));
    el.textContent = fmt(to);
    if (still || !first || !(to > 0) || document.hidden) return;
    var t0 = performance.now();
    requestAnimationFrame(function frame(now) {
      if (el.getAttribute("data-n") !== String(to)) return; // a newer value took over
      var k = Math.max(0, Math.min(1, (now - t0) / COUNT_MS));
      el.textContent = fmt(k < 1 ? to * (1 - Math.pow(1 - k, 3)) : to);
      if (k < 1) requestAnimationFrame(frame);
    });
  }

  return { ruleCheck: ruleCheck, featured: featured, activity: activity, countUp: countUp, ago: ago, checkClass: checkClass, RUN: RUN, CHECKS: CHECKS };
})();
