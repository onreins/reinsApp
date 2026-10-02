/* The strategy page: a backtested template, drawn from /data/strategies.json.
   The hero chart, the money calculator and the drawdown chart follow one
   start date (since 2024, or since 2021); the year bars and the rules don't.
   The numbers come from strategy-math.js, which has its own tests. */
(function () {
  "use strict";
  var U = window.ReinsUI, M = window.ReinsStrategyMath;
  var $ = function (id) { return document.getElementById(id); };
  var esc = U.esc;
  var START = { "2024": Date.UTC(2024, 0, 1) / 1000, "2021": 0 };
  var MIN_AMOUNT = 1;
  var MAX_AMOUNT = 10000000;
  var TICKS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500];
  var MAX_TICKS = 6;
  var NARROW = 520;
  var LABEL_GAP = 14; // px between the two end-of-line labels

  var id = new URLSearchParams(location.search).get("s") || "";
  var doc = null, s = null, range = "2024", amount = 1000;
  var view = null; // { a, b }: strategy and holding, rebased to the start date
  var geo = null;  // the hero chart's geometry, for the hover readout

  var multiple = function (v) { return v >= 10 ? v.toFixed(0) + "×" : v >= 2 ? v.toFixed(1) + "×" : v.toFixed(2) + "×"; };
  var day = function (t) { return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  var monthYear = function (t) { return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" }); };
  var dollars = function (n) { return U.money(n, Math.abs(n) >= 100 ? 0 : 2); };
  var last = function (list) { return list[list.length - 1]; };
  var minOf = function (list) { return Math.min.apply(null, list); };

  U.topbar("strategies");
  $("crumb-ic").outerHTML = U.icon("right");

  // ------------------------------------------------------------ the header
  function renderHead() {
    var st = s.stats, valid = s.status === "validated";
    document.title = s.name + " · Reins";
    $("crumb-name").textContent = s.name;
    $("av").innerHTML = U.coins(s.universe);
    $("tags").innerHTML = '<span class="tagp' + (valid ? " ok" : "") + '" title="' +
      (valid ? "Held up on data it was not tuned on" : "Promising, not yet confirmed on unseen data") + '">' + (valid ? "Validated" : "Candidate") + "</span>" +
      '<span class="tagp" title="Results come from historical prices, not live trading">Backtest</span>' + U.strategyRisk(s);
    $("name").textContent = s.name;
    $("tagline").textContent = s.tagline;
    $("fine").textContent = doc.note + " Costs: " + doc.costs + ". " + s.onArc;
    $("u-go").href = "/create.html?s=" + encodeURIComponent(s.id);
    $("lg-strat").textContent = s.name;
    $("lg-bench").textContent = s.bench.name;
    $("k-strat-l").textContent = s.name;

    $("s-since").innerHTML = U.pctHtml(st.cagr_since_2024 * 100, 0);
    $("s-all").innerHTML = U.pctHtml(st.cagr * 100, 0);
    $("s-dd").textContent = U.pct(st.max_drawdown * 100, 0);
    $("s-wm").textContent = "Worst month " + U.pct(st.worst_month * 100, 0);
    $("s-sharpe").textContent = st.sharpe.toFixed(2);
    $("s-pf").textContent = st.trade_pf != null ? "Profit factor " + st.trade_pf.toFixed(2) : "";
    $("s-tpm").textContent = st.trades_per_month != null ? String(st.trades_per_month) : "—";
    $("s-hold").textContent = "Holds " + s.hold.toLowerCase();

    renderRules();
    renderTrades();
    renderYears();
  }

  function renderRules() {
    var st = s.stats, loss = M.lossLimit(st.max_drawdown);
    // [icon, title, detail, enforced by the contract?]
    var rules = [
      ["freeze", "Loss limit −" + loss + "%", "Its worst backtested drop was " + Math.round(Math.abs(st.max_drawdown) * 100) + "%. Past the floor, anyone can freeze it.", true],
      ["filter", "Largest trade: a fifth of the deposit", "Anything bigger reverts on-chain.", true],
      ["shield", "Every fill is price-checked", "Against an oracle price. A worse fill reverts.", true],
      ["exit", "Withdraw any time", "Owner only, even mid-trade. Nobody can object.", true],
      ["minus", "Stops buying at half the loss budget", "Sells are still allowed.", false],
      ["info", "Pauses at 80% of the loss budget", "Before the contract would freeze it.", false],
      ["wallet", "No coin above about a third", "Spreads the risk across coins.", false],
      ["window", "Runs for 90 days, renewable", "An expiry set when the agent is created.", true],
    ];
    $("rules").innerHTML = rules.map(function (r) {
      return '<li class="' + (r[3] ? "chain" : "") + '"><span class="ri">' + U.icon(r[0]) + "</span><span><b>" + esc(r[1]) + "</b><small>" + esc(r[2]) + "</small></span></li>";
    }).join("");
  }

  function renderTrades() {
    var st = s.stats;
    $("trades").innerHTML = [
      ["Trades", st.trades != null ? st.trades.toLocaleString("en-US") : "—", "in the backtest"],
      ["Trades a month", st.trades_per_month != null ? String(st.trades_per_month) : "—"],
      ["Winning trades", st.win_rate != null ? Math.round(st.win_rate * 100) + "%" : "—"],
      ["Profit factor", st.trade_pf != null ? st.trade_pf.toFixed(2) : "—", "gains ÷ losses"],
      ["Average trade", st.avg_trade != null ? U.pct(st.avg_trade * 100, 2) : "—", "after costs"],
      ["Positive months", Math.round(st.positive_months * 100) + "%"],
    ].map(function (c) { return "<div><dt>" + c[0] + "</dt><dd>" + c[1] + (c[2] ? "<small>" + c[2] + "</small>" : "") + "</dd></div>"; }).join("");
  }

  // ------------------------------------------------------- year by year
  function renderYears() {
    var years = Object.keys(s.years), bench = s.bench.years || {};
    var sv = years.map(function (y) { return s.years[y]; });
    var bv = years.map(function (y) { return bench[y] != null ? bench[y] : 0; });
    var cap = M.yearCap(sv, bv);
    var negSpan = Math.min(cap, -Math.min(0, minOf(sv), minOf(bv)));
    var total = negSpan + cap, zero = (negSpan / total) * 100;
    var endMonth = new Date(doc.period[1]).toLocaleDateString("en-US", { month: "short" });
    var bar = function (v, cls, faded) {
      var room = v < 0 ? negSpan : cap, w = (Math.min(Math.abs(v), room) / total) * 100;
      var left = v < 0 ? zero - w : zero;
      return '<span class="b ' + cls + '"><i class="' + (v < 0 ? "neg" : "") + (faded || Math.abs(v) > room ? " clip" : "") +
        '" style="left:' + left.toFixed(2) + "%;width:" + w.toFixed(2) + '%"></i></span>';
    };
    $("years").innerHTML = years.map(function (y, i) {
      var partial = y === String(new Date(doc.period[1]).getUTCFullYear());
      // A year past the scale is shrunk as a pair, so the larger bar still shows as larger.
      var fit = M.yearBars(sv[i], bv[i], cap);
      var note = fit.scaled ? "not to scale" : partial ? "to " + endMonth : "";
      return '<li><span class="y">' + esc(y) + (note ? "<small>" + note + "</small>" : "") + "</span>" +
        '<span class="bars" style="--zero:' + zero.toFixed(2) + '%">' + bar(fit.s, "s", fit.scaled) + bar(fit.b, "h", fit.scaled) + "</span>" +
        '<span class="v">' + U.pctHtml(sv[i] * 100, 0) + "<small>holding " + U.pct(bv[i] * 100, 0) + "</small></span></li>";
    }).join("");
  }

  // ------------------------------------------------------- the start date
  function setRange(r) {
    range = r;
    document.querySelectorAll("[data-r]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-r") === r)); });
    view = { a: M.rebase(s.curve, START[r]), b: M.rebase(s.bench.curve, START[r]) };
    renderChart();
    renderDrawdowns();
    renderCalc();
  }

  // ------------------------------------------------- hero: growth of $1
  function renderChart() {
    var a = view.a, b = view.b, plot = $("plot");
    if (a.length < 2 || b.length < 2) { plot.innerHTML = '<div class="plot-empty">Not enough history for this range.</div>'; geo = null; return; }
    var W = Math.max(300, Math.round(plot.clientWidth || 700)), H = W < NARROW ? 220 : 290, L = 44, R = 46, T = 10, B = 24;
    var vals = a.concat(b).map(function (p) { return p.v; });
    var lo = Math.log(minOf(vals)), hi = Math.log(Math.max.apply(null, vals));
    var pad = (hi - lo) * 0.08 || 0.1; lo -= pad; hi += pad;
    var t0 = a[0].t, t1 = last(a).t;
    var X = function (t) { return L + ((t - t0) / (t1 - t0)) * (W - L - R); };
    var Y = function (v) { return T + (1 - (Math.log(v) - lo) / (hi - lo)) * (H - T - B); };
    var line = function (pts) { return pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join(" "); };
    var ticks = TICKS.filter(function (v) { var l = Math.log(v); return l >= lo && l <= hi; });
    if (ticks.length > MAX_TICKS) ticks = ticks.filter(function (v, i) { return i % 2 === 0 || v === 1; });

    var out = '<defs><linearGradient id="sg-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d8bff" stop-opacity=".32"/><stop offset="1" stop-color="#3d8bff" stop-opacity="0"/></linearGradient></defs>';
    ticks.forEach(function (v) {
      out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" class="g' + (v === 1 ? " one" : "") + '"/>' +
        '<text x="' + (L - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + multiple(v) + "</text>";
    });
    yearLabels(t0, t1, X, H - 6).forEach(function (l) { out += l; });
    var sp = line(a);
    out += '<path d="' + sp + " L" + X(t1).toFixed(1) + " " + (H - B) + " L" + X(t0).toFixed(1) + " " + (H - B) + ' Z" class="a-strat"/>' +
      '<path d="' + line(b) + '" class="l-bench"/><path d="' + sp + '" class="l-strat"/>';
    var ea = last(a).v, eb = last(b).v;
    // Two finishes close together would print on top of each other: push them apart.
    var ya = Y(ea), yb = Y(eb), gap = LABEL_GAP - Math.abs(ya - yb);
    if (gap > 0) { var push = (gap / 2) * (ya <= yb ? 1 : -1); ya -= push; yb += push; }
    out += '<text x="' + (W - R + 6) + '" y="' + (ya + 4).toFixed(1) + '" class="end strat">' + multiple(ea) + "</text>" +
      '<text x="' + (W - R + 6) + '" y="' + (yb + 4).toFixed(1) + '" class="end">' + multiple(eb) + "</text>";
    out += '<g class="cur" id="cur" visibility="hidden"><line id="cur-l" y1="' + T + '" y2="' + (H - B) + '"/>' +
      '<circle id="cur-b" r="3.5" fill="#7d84a8"/><circle id="cur-a" r="4.5" fill="#5aaeff"/></g>';
    plot.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="In the backtest, ' + esc(s.name) + " turned $1 into $" + ea.toFixed(2) +
      " since " + monthYear(t0) + ", against $" + eb.toFixed(2) + ' for holding">' + out + "</svg>";
    geo = { W: W, L: L, R: R, t0: t0, t1: t1, X: X, Y: Y };
    readAt(a.length - 1, false);
  }

  function yearLabels(t0, t1, X, y) {
    var out = [];
    for (var yr = 2021; yr <= 2030; yr++) {
      var t = Date.UTC(yr, 0, 1) / 1000;
      if (t >= t0 && t <= t1) out.push('<text x="' + X(t).toFixed(1) + '" y="' + y + '" text-anchor="middle">' + yr + "</text>");
    }
    return out;
  }

  var nearest = function (pts, t) {
    var best = 0;
    for (var i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    return best;
  };
  var cursor = -1;

  // The readout above the chart: a point in time, or the end when nothing is hovered.
  function readAt(i, show) {
    if (!geo) return;
    var pa = view.a[i], pb = view.b[nearest(view.b, pa.t)];
    cursor = i;
    $("read").innerHTML = esc(day(pa.t)) + " · <b>" + esc(s.name) + " " + multiple(pa.v) + "</b> · <i>holding " + multiple(pb.v) + "</i>";
    var cur = $("cur");
    if (!cur) return;
    cur.setAttribute("visibility", show ? "visible" : "hidden");
    if (!show) return;
    var x = geo.X(pa.t).toFixed(1);
    $("cur-l").setAttribute("x1", x);
    $("cur-l").setAttribute("x2", x);
    $("cur-a").setAttribute("cx", x);
    $("cur-a").setAttribute("cy", geo.Y(pa.v).toFixed(1));
    $("cur-b").setAttribute("cx", geo.X(pb.t).toFixed(1));
    $("cur-b").setAttribute("cy", geo.Y(pb.v).toFixed(1));
  }

  function wireChart() {
    var plot = $("plot");
    plot.addEventListener("pointermove", function (ev) {
      var svg = plot.querySelector("svg");
      if (!geo || !svg) return;
      var box = svg.getBoundingClientRect();
      var x = ((ev.clientX - box.left) / box.width) * geo.W;
      var t = geo.t0 + ((x - geo.L) / (geo.W - geo.L - geo.R)) * (geo.t1 - geo.t0);
      readAt(nearest(view.a, t), true);
    });
    plot.addEventListener("pointerleave", function () { if (view) readAt(view.a.length - 1, false); });
    plot.addEventListener("keydown", function (ev) {
      if (!view) return;
      var n = view.a.length, i = cursor < 0 ? n - 1 : cursor;
      var to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      readAt(Math.max(0, Math.min(n - 1, to)), true);
    });
    plot.addEventListener("focus", function () { $("read").setAttribute("aria-live", "polite"); });
    plot.addEventListener("blur", function () {
      $("read").setAttribute("aria-live", "off");
      if (view) readAt(view.a.length - 1, false);
    });
  }

  // ------------------------------------------------------------ drawdowns
  function renderDrawdowns() {
    var a = view.a, b = view.b, box = $("dd");
    if (a.length < 2) { box.innerHTML = ""; return; }
    var da = M.drawdowns(a.map(function (p) { return p.v; })), db = M.drawdowns(b.map(function (p) { return p.v; }));
    var floor = Math.min(minOf(da), minOf(db), -0.05) * 1.08;
    var W = Math.max(300, Math.round(box.clientWidth || 520)), H = W < NARROW ? 170 : 200, L = 44, R = 12, T = 8, B = 22;
    var t0 = a[0].t, t1 = last(a).t;
    var X = function (t) { return L + ((t - t0) / (t1 - t0)) * (W - L - R); };
    var Y = function (d) { return T + (d / floor) * (H - T - B); };
    var line = function (pts, dd) { return pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(dd[i]).toFixed(1); }).join(" "); };
    var step = floor < -0.6 ? 0.2 : 0.1, out = "";
    for (var d = 0; d >= floor; d -= step) {
      var v = Math.round(d * 100) / 100;
      out += '<line class="g" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/>' +
        '<text x="' + (L - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + (v === 0 ? "0%" : U.pct(v * 100, 0)) + "</text>";
    }
    yearLabels(t0, t1, X, H - 4).forEach(function (l) { out += l; });
    var sp = line(a, da);
    out += '<path class="a-strat" d="' + sp + " L" + X(t1).toFixed(1) + " " + T + " L" + X(t0).toFixed(1) + " " + T + ' Z"/>' +
      '<path class="l-bench" d="' + line(b, db) + '"/><path class="l-strat" d="' + sp + '"/>';
    var worst = da.indexOf(minOf(da)), wx = X(a[worst].t);
    out += '<text class="low" x="' + Math.min(W - R - 20, Math.max(L + 20, wx)).toFixed(1) + '" y="' + Math.min(H - B - 2, Y(da[worst]) + 15).toFixed(1) +
      '" text-anchor="middle">' + U.pct(da[worst] * 100, 0) + "</text>";
    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="In the backtest, its deepest fall from a previous high: ' + U.pct(da[worst] * 100, 0) +
      ", against " + U.pct(minOf(db) * 100, 0) + ' for holding">' + out + "</svg>";
    $("dd-note").textContent = "Since " + monthYear(t0) + ", its deepest fall from a previous high was " + U.pct(da[worst] * 100, 0) +
      " in " + monthYear(a[worst].t) + ", on weekly closes. Holding fell as far as " + U.pct(minOf(db) * 100, 0) +
      ". The worst-drop figure above, " + U.pct(s.stats.max_drawdown * 100, 0) + ", is measured on daily prices across the whole backtest.";
  }

  // ---------------------------------------- what your money would have done
  function renderCalc() {
    var a = view.a, b = view.b;
    if (a.length < 2) return;
    var loss = M.lossLimit(s.stats.max_drawdown);
    var endA = amount * last(a).v, endB = amount * last(b).v;
    var top = Math.max(endA, endB, amount);
    $("headline").innerHTML = '<span class="from">In the backtest, ' + esc(dollars(amount)) + " put in " + esc(monthYear(a[0].t)) + " would now be</span>" +
      '<span class="to ' + (endA >= amount ? "up" : "down") + '">' + esc(dollars(endA)) + "</span>";
    $("vs").innerHTML = esc(s.bench.name) + ": <b>" + esc(dollars(endB)) + "</b>";
    $("k-strat").textContent = dollars(endA);
    $("k-bench").textContent = dollars(endB);
    $("k-strat-bar").style.width = ((endA / top) * 100).toFixed(1) + "%";
    $("k-bench-bar").style.width = ((endB / top) * 100).toFixed(1) + "%";

    var low = M.lowest(a), froze = M.freezeAt(a, loss);
    var dd = minOf(M.drawdowns(a.map(function (p) { return p.v; })));
    var ahead = endA - endB;
    var facts = [
      ["", ahead >= 0 ? "Ahead of holding by" : "Behind holding by", dollars(Math.abs(ahead)), "after trading costs"],
      low.v < 1
        ? ["", "At its lowest", dollars(amount * low.v), U.pct((low.v - 1) * 100, 0) + " from your deposit, " + day(low.t)]
        : ["", "At its lowest", dollars(amount), "It never closed a week below what you put in"],
      ["", "Deepest fall from a high", U.pct(dd * 100, 0), "on weekly closes; the worst stretch to sit through"],
      [froze ? "hit" : "", "Your agent’s floor", dollars(amount * (1 - loss / 100)),
        "At a " + loss + "% loss limit. " + (froze
          ? "It would have frozen on " + day(froze.t) + "; the figures above assume it kept trading."
          : "Not reached on weekly closes from this start date.")],
    ];
    $("k-facts").innerHTML = facts.map(function (f) {
      return '<div class="sg-fact ' + f[0] + '"><dt>' + esc(f[1]) + "</dt><dd>" + esc(f[2]) + "<small>" + esc(f[3]) + "</small></dd></div>";
    }).join("");
  }

  function wireCalc() {
    var input = $("k-amt");
    input.addEventListener("input", function () {
      var v = Number(input.value);
      if (input.value === "" || !isFinite(v) || v < MIN_AMOUNT) return; // keep the last good amount while typing
      amount = Math.min(MAX_AMOUNT, v);
      if (view) renderCalc();
    });
    // Once they leave the field it shows the amount the figures actually use.
    input.addEventListener("change", function () { input.value = String(amount); });
    document.querySelectorAll("[data-amt]").forEach(function (b) {
      b.addEventListener("click", function () {
        amount = Number(b.getAttribute("data-amt"));
        input.value = String(amount);
        if (view) renderCalc();
      });
    });
    document.querySelectorAll("[data-r]").forEach(function (b) {
      b.addEventListener("click", function () { if (s) setRange(b.getAttribute("data-r")); });
    });
  }

  // ---------------------------------------------------------------- start
  var resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!view || window.innerWidth === lastWidth) return; // a phone's URL bar only changes the height
      lastWidth = window.innerWidth;
      renderChart();
      renderDrawdowns();
    }, 150);
  });
  wireChart();
  wireCalc();

  U.getJson("/data/strategies.json").then(function (d) {
    doc = d;
    s = (d.strategies || []).filter(function (x) { return x.id === id; })[0];
    if (!s) {
      missing("Strategy not found", '<a class="chip" href="/#strategies">See all strategies</a>');
      return;
    }
    renderHead();
    setRange(range);
  }).catch(function (err) {
    console.error("[strategy]", err); // a render bug lands here too
    missing("Couldn’t load this strategy", "Reload the page to try again.");
  });

  // Nothing to show: say so, and hide the sections that would sit empty.
  function missing(title, body) {
    document.body.classList.add("sg-missing");
    document.title = title + " · Reins";
    $("name").textContent = title;
    $("crumb-name").textContent = "Not found";
    $("tagline").innerHTML = body;
  }
})();
