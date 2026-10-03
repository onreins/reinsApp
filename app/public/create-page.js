/* The create page: fund it, set its limits, name it. Every limit is a slider
   with its consequence in dollars beside it; presets only move the sliders.
   The agent card on the right shows, in plain words, exactly what the wallet
   is about to sign. Rules come from create-math.js; signing and sending go
   through wallet.js, as before. */
(function () {
  "use strict";
  var U = window.ReinsUI, W = window.ReinsWallet, C = window.ReinsCreate, O = window.ReinsOnramp;
  var $ = function (id) { return document.getElementById(id); };
  var esc = U.esc, money = U.money;

  var ZERO = "0x0000000000000000000000000000000000000000";
  var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var AMOUNTS = [10, 50, 100, 500];
  var DURATIONS = [["month", "30 days"], ["quarter", "90 days"], ["year", "1 year"]];
  var POLL_MS = 2000, POLL_TRIES = 60;

  var cfg = null, busy = false, walletUsdc = null;
  var presets = [C.PERSONALITIES.careful, C.PERSONALITIES.balanced, C.PERSONALITIES.bold];
  // The limits as the user set them. The largest trade is a share of the deposit,
  // so it follows the deposit when that changes.
  var state = { deposit: 50, lossPercent: 10, tradeShare: 0.2, bandPercent: 1, keyMode: "later" };

  U.topbar("create");

  // ------------------------------------------------------------- the rules
  function readForm() {
    var r = C.rulesFor(state, state.deposit);
    return {
      name: $("f-name").value.trim(),
      agent: state.keyMode === "later" ? ZERO : $("f-agent").value.trim(),
      deposit: state.deposit,
      rules: {
        maxTradeUsd: r.maxTradeUsd,
        maxLossPercent: r.maxLossPercent,
        maxSlippagePercent: r.maxSlippagePercent,
        maxPriceAgeSeconds: Math.round(Number($("f-age").value) * 3600),
        expiryDays: Number($("f-days").value),
      },
    };
  }

  // ------------------------------------------------------------ 1. money
  $("amounts").innerHTML = AMOUNTS.map(function (a) { return '<button type="button" class="chip" data-amt="' + a + '">$' + a + "</button>"; }).join("");
  function setDeposit(v) {
    state.deposit = Math.max(0, Number(v) || 0);
    render();
  }
  $("f-deposit").addEventListener("input", function () { setDeposit($("f-deposit").value); });
  $("amounts").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-amt]");
    if (!b) return;
    $("f-deposit").value = b.getAttribute("data-amt");
    setDeposit(b.getAttribute("data-amt"));
  });

  // ----------------------------------------------------------- 2. limits
  // A preset moves the sliders; nothing more.
  function renderPresets() {
    $("presets").innerHTML = presets.map(function (p) {
      return '<button type="button" class="chip" data-preset="' + esc(p.id) + '">' + U.icon(p.icon) + esc(p.label) + "</button>";
    }).join("");
  }
  function applyPreset(p) {
    state.lossPercent = p.lossPercent;
    state.tradeShare = p.tradeShare;
    state.bandPercent = p.bandPercent;
    syncSliders();
    render();
  }
  $("presets").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-preset]");
    if (!b) return;
    var p = presets.filter(function (x) { return x.id === b.getAttribute("data-preset"); })[0];
    if (p) applyPreset(p);
  });
  var matching = function () {
    return presets.filter(function (p) {
      return p.lossPercent === state.lossPercent && p.tradeShare === state.tradeShare && p.bandPercent === state.bandPercent;
    })[0] || null;
  };

  // Each slider paints its own fill up to the thumb.
  function paint(input) {
    var min = Number(input.min), max = Number(input.max), v = Number(input.value);
    input.style.setProperty("--p", (((v - min) / (max - min)) * 100).toFixed(1) + "%");
  }
  function syncSliders() {
    $("l-loss").value = state.lossPercent;
    $("l-trade").value = Math.round(state.tradeShare * 100);
    $("l-band").value = state.bandPercent;
    ["l-loss", "l-trade", "l-band"].forEach(function (id) { paint($(id)); });
  }
  $("l-loss").addEventListener("input", function () { state.lossPercent = Number($("l-loss").value); paint($("l-loss")); render(); });
  $("l-trade").addEventListener("input", function () { state.tradeShare = Number($("l-trade").value) / 100; paint($("l-trade")); render(); });
  $("l-band").addEventListener("input", function () { state.bandPercent = Number($("l-band").value); paint($("l-band")); render(); });

  $("durations").innerHTML = DURATIONS.map(function (d) { return '<button type="button" class="chip" data-days="' + C.DAYS[d[0]] + '">' + d[1] + "</button>"; }).join("");
  $("durations").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-days]");
    if (!b) return;
    $("f-days").value = b.getAttribute("data-days");
    render();
  });
  ["f-days", "f-age"].forEach(function (id) { $(id).addEventListener("input", render); });

  // ------------------------------------------------ 3. name and the trader
  function rollName() {
    $("f-name").value = C.nameIdea(Math.random(), Math.random());
    var d = $("dice");
    d.classList.remove("roll");
    void d.offsetWidth; // restart the spin
    d.classList.add("roll");
    render();
  }
  $("dice").addEventListener("click", rollName);
  $("f-name").addEventListener("input", render);
  function setKeyMode(mode) {
    state.keyMode = mode;
    document.querySelectorAll("[data-key]").forEach(function (b) {
      var on = b.getAttribute("data-key") === mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $("keybox").hidden = mode !== "own";
    render();
  }
  document.querySelectorAll("[data-key]").forEach(function (b) {
    b.addEventListener("click", function () {
      setKeyMode(b.getAttribute("data-key"));
      if (state.keyMode === "own") $("f-agent").focus();
    });
  });
  $("keys").addEventListener("keydown", function (ev) {
    if (!/^Arrow/.test(ev.key)) return;
    ev.preventDefault();
    setKeyMode(state.keyMode === "later" ? "own" : "later");
    document.querySelector('[data-key="' + state.keyMode + '"]').focus();
  });
  $("f-agent").addEventListener("input", function () {
    if ($("f-agent").getAttribute("aria-invalid") === "true") setAgentError("");
    render();
  });

  // ------------------------------------------------------------ rendering
  var when = function (days) { return new Date(Date.now() + days * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  var daysText = function (d) { return d === 365 ? "1 year" : d % 365 === 0 ? d / 365 + " years" : d + (d === 1 ? " day" : " days"); };
  function rule(icon, text, small) { return '<li><span class="ri">' + U.icon(icon) + "</span><span>" + text + "<small>" + small + "</small></span></li>"; }

  function renderLimits(f, floor) {
    var r = f.rules;
    $("o-loss").textContent = "−" + r.maxLossPercent + "%";
    $("h-loss").textContent = "Freezes trading if it falls to " + money(floor) + ". Past that line, anyone can pull the brake.";
    $("o-trade").textContent = money(r.maxTradeUsd);
    $("h-trade").textContent = Math.round(state.tradeShare * 100) + "% of the deposit. A bigger trade is refused.";
    $("o-band").textContent = r.maxSlippagePercent + "%";
    $("h-band").textContent = "Refuses any fill more than " + r.maxSlippagePercent + "% worse than the market price.";
    $("o-days").textContent = daysText(r.expiryDays);
    var m = matching();
    document.querySelectorAll("[data-preset]").forEach(function (b) { b.setAttribute("aria-pressed", String(!!m && m.id === b.getAttribute("data-preset"))); });
    document.querySelectorAll("[data-days]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-days")) === r.expiryDays)); });
    document.querySelectorAll("[data-amt]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-amt")) === f.deposit)); });
  }

  function renderCard(f, floor) {
    var r = f.rules, m = matching();
    var name = f.name || "Your agent";
    var pseudo = "0x" + name.split("").map(function (c) { return c.charCodeAt(0).toString(16); }).join("").padEnd(40, "0").slice(0, 40);
    $("card-av").innerHTML = U.avatar({ address: pseudo, name: name });
    $("card-name").textContent = name;
    $("card-sub").textContent = (m ? m.label : "Your own limits") + " · " +
      (state.keyMode === "later" ? "no bot yet" : ADDRESS.test(f.agent) ? "bot " + U.short(f.agent) : "bot key needed");
    $("card-big").textContent = money(f.deposit);
    $("floor-fill").style.width = "100%";
    $("floor-mark").style.left = Math.max(0, Math.min(100, 100 - r.maxLossPercent)).toFixed(1) + "%";
    $("floor-text").innerHTML = "<span>Starts at " + esc(money(f.deposit)) + "</span><span>Stop-loss at <b>" + esc(money(floor)) + "</b></span>";
    $("card-rules").innerHTML =
      rule("freeze", "Stops trading if it falls to " + esc(money(floor)), "A " + r.maxLossPercent + "% loss. Past it, anyone can pull the brake") +
      rule("filter", "Never trades more than " + esc(money(r.maxTradeUsd)) + " at once", "A bigger trade is refused on-chain") +
      rule("shield", "Only fills within " + r.maxSlippagePercent + "% of the market price", "A worse fill is refused") +
      rule("wallet", "Trades USDC and EURC", "Tokenized stocks when they reach Arc") +
      rule("window", "Runs until " + esc(when(r.expiryDays)), "Then it stops by itself") +
      rule("exit", "You can withdraw any time", "Its trading key can’t move money out") +
      (state.keyMode === "later"
        ? rule("agent", "No bot yet", "Nobody can trade until you add a trading key from its page")
        : rule("agent", ADDRESS.test(f.agent) ? "Trades with " + esc(U.short(f.agent)) : "Paste your bot’s address", "That key can trade, never withdraw"));
    $("compiled").innerHTML =
      '<span class="k">maxTradeValue</span> ' + Math.round(r.maxTradeUsd * 1e6).toLocaleString("en-US") + "<br>" +
      '<span class="k">maxDrawdownBps</span> ' + Math.round(r.maxLossPercent * 100) + "<br>" +
      '<span class="k">maxSlippageBps</span> ' + Math.round(r.maxSlippagePercent * 100) + "<br>" +
      '<span class="k">maxPriceAge</span> ' + r.maxPriceAgeSeconds.toLocaleString("en-US") + " s<br>" +
      '<span class="k">expiresAt</span> ' + Math.floor((Date.now() + r.expiryDays * 86400000) / 1000) + "<br>" +
      '<span class="k">agent</span> ' + esc(f.agent === ZERO ? "none (set later)" : f.agent);
  }

  function render() {
    var f = readForm(), floor = C.floorOf(f.deposit, f.rules.maxLossPercent);
    renderLimits(f, floor);
    renderCard(f, floor);
    $("t-1").classList.toggle("done", f.deposit > 0);
    $("t-2").classList.add("done");
    $("t-3").classList.toggle("done", !!f.name && (state.keyMode === "later" || ADDRESS.test(f.agent)));
    shortfall();
  }

  // ------------------------------------------------------------- creating
  function step(html, cls) {
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.innerHTML = html;
    $("steps").appendChild(div);
  }
  function notice(msg) { $("notice").hidden = false; $("notice").textContent = msg; }
  var link = function (h) { return '<a href="' + cfg.explorer + "/tx/" + h + '" target="_blank" rel="noopener">' + h.slice(0, 10) + "…</a>"; };
  function setAgentError(msg) {
    $("f-agent").setAttribute("aria-invalid", msg ? "true" : "false");
    $("f-agent-err").textContent = msg;
    if (msg) $("f-agent").focus();
    return !msg;
  }
  async function waitCreated(hash) {
    for (var i = 0; i < POLL_TRIES; i++) {
      // A failed read is a hiccup, not a verdict: the transaction is already sent.
      var res = await U.getJson("/api/tx/created?hash=" + hash).catch(function () { return { status: "pending" }; });
      if (res.status === "success") return res.mandate;
      if (res.status === "reverted") throw new Error("The create transaction reverted.");
      await new Promise(function (r) { setTimeout(r, POLL_MS); });
    }
    throw new Error("Timed out waiting for the transaction.");
  }
  var idleLabel = function () { return W.account ? "Hand over the reins" : "Connect wallet to create"; };

  async function create(ev) {
    ev.preventDefault();
    if (busy) return;
    if (!W.account) {
      try { await U.connect(); } catch (err) { notice(W.explain(err)); }
      return;
    }
    if (!$("f-name").value.trim()) rollName();
    var f = readForm();
    if (state.keyMode === "own" && !setAgentError(!ADDRESS.test(f.agent)
      ? "Enter a full 0x address, 42 characters: the key your bot trades with."
      : f.agent.toLowerCase() === W.account.toLowerCase()
        ? "That’s your own wallet. The contract refuses it, so use a separate key for the bot."
        : "")) return;

    busy = true;
    $("go").disabled = true;
    $("go").setAttribute("aria-busy", "true");
    $("notice").hidden = true;
    $("steps").innerHTML = "";
    try {
      $("go").textContent = "Check your wallet…";
      await W.ensureChain();
      var h1 = await W.send(await W.post("/api/tx/create", { name: f.name, agent: f.agent, rules: f.rules }));
      step("Create sent · " + link(h1));
      var mandate = await waitCreated(h1);
      step("Your agent is live at " + mandate.slice(0, 10) + "…", "ok");
      if (f.deposit > 0) {
        var dep = await W.post("/api/tx/deposit", { mandate: mandate, amountUsd: f.deposit });
        for (var i = 0; i < dep.txs.length; i++) {
          $("go").textContent = dep.txs[i].label + ": check your wallet…";
          step(esc(dep.txs[i].label) + " · " + link(await W.send(dep.txs[i])));
        }
        step("Funded with " + money(f.deposit), "ok");
      }
      step("Done. Opening your agent.", "ok");
      location.href = "/mandate.html?a=" + mandate;
    } catch (err) {
      step(esc(W.explain(err)), "err");
      notice(W.explain(err));
      $("go").disabled = false;
      $("go").textContent = idleLabel();
    } finally {
      busy = false;
      $("go").removeAttribute("aria-busy");
    }
  }
  $("form").addEventListener("submit", create);
  $("go").addEventListener("click", function (ev) { create(ev); });
  U.onAccount(function () { $("go").textContent = idleLabel(); readWallet(); });

  // ----------------------------------------------------------- card top-up
  function shortfall() {
    var need = state.deposit - (walletUsdc || 0);
    $("w-short").textContent = walletUsdc != null && need > 0.005 ? "You need " + money(need) + " more to fund this." : "";
  }
  function showBalance(v) {
    walletUsdc = v;
    $("w-usdc").textContent = v == null ? "Couldn’t read your wallet’s USDC" : "Your wallet holds " + money(v);
    shortfall();
  }
  async function readWallet() { if (W.account) showBalance(await O.usdcOf(W.account)); }
  O.status().then(function (st) {
    if (st.enabled) return;
    $("buy").disabled = true;
    $("buy").textContent = "Card top-ups: soon";
    $("buy").title = "Buying USDC with a card switches on once the Circle key is set up.";
  });
  $("buy").addEventListener("click", async function () {
    if (!W.account) {
      try { await U.connect(); } catch (err) { notice(W.explain(err)); return; }
    }
    O.open({ address: W.account, onFunded: showBalance });
  });

  // ---------------------------------------------------------------- start
  W.config().then(function (c) {
    cfg = c;
    if (!W.available) notice("No wallet detected. You can look around; creating an agent needs a browser wallet.");
  });
  $("dice").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>';
  $("go").textContent = idleLabel();
  renderPresets();
  rollName();
  setKeyMode("later");
  applyPreset(C.PERSONALITIES.balanced);

  // Opened from a strategy page (?s=id): its limits come first, set from its backtest.
  var template = new URLSearchParams(location.search).get("s");
  if (template) {
    U.getJson("/data/strategies.json").then(function (d) {
      var s = (d.strategies || []).filter(function (x) { return x.id === template; })[0];
      if (!s) return;
      var t = C.fromTemplate(s);
      presets = [t].concat(presets);
      renderPresets();
      $("f-name").value = s.name + " agent";
      $("f-days").value = C.DAYS.quarter;
      $("template").innerHTML = "Started from the <b>" + esc(s.name) + "</b> template: its stop-loss sits a little beyond its worst backtested drop. Change anything. " +
        esc(s.onArc) + ' <a href="/strategy.html?s=' + encodeURIComponent(s.id) + '">See the strategy</a>';
      $("template").hidden = false;
      applyPreset(t);
    }).catch(function () { /* the presets still work */ });
  }
})();
