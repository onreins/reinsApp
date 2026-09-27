/**
 * Shared pieces of the Reins app: formatting, the top bar, holdings avatars,
 * return maths and charts. Every page loads this after wallet.js; nothing
 * here ever sees a key.
 */
window.ReinsUI = (function () {
  "use strict";
  var W = window.ReinsWallet;
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ formatting
  var FLAT = 0.005; // under half a basis point is rounding, not a move

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  var short = function (a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; };
  function money(n, dp) {
    if (n === null || n === undefined) return "—";
    var d = dp === undefined ? 2 : dp;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // Chamber style: $14.17M, $22.4K, $1.75.
  function compact(n) {
    if (n === null || n === undefined) return "—";
    var a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return "$" + (n / 1e3).toFixed(1) + "K";
    return money(n);
  }
  // The headline: whole cents full weight, sub-cent digits dimmed.
  function bigMoneyHtml(n) {
    if (n === null || n === undefined) return "—";
    if (Math.abs(n) >= 100) return esc(money(n));
    var s = money(n, 4);
    return esc(s.slice(0, -2)) + '<span class="sub-cents">' + s.slice(-2) + "</span>";
  }
  var dirOf = function (p) { return p === null || p === undefined || Math.abs(p) < FLAT ? "flat" : p > 0 ? "up" : "down"; };
  function pct(p, dp) {
    if (p === null || p === undefined || isNaN(p)) return "—";
    var d = dp === undefined ? 2 : dp;
    if (Math.abs(p) < FLAT) return (0).toFixed(d) + "%";
    return (p > 0 ? "+" : "−") + Math.abs(p).toFixed(d) + "%";
  }
  var pctHtml = function (p, dp) { return '<span class="' + dirOf(p) + '">' + pct(p, dp) + "</span>"; };
  function stateOf(r) {
    if (r.closed) return ["closed", "Closed"];
    if (r.frozen) return ["frozen", "Frozen"];
    if (r.expired) return ["expired", "Expired"];
    return ["live", "Live"];
  }
  // Risk from the one number that bounds the downside: the loss limit.
  function riskOf(r) {
    var l = r && r.rules ? r.rules.maxLossPercent : null;
    if (l === null || l === undefined) return null;
    var n = l <= 5 ? 1 : l <= 10 ? 2 : l <= 20 ? 3 : l <= 35 ? 4 : 5;
    return { n: n, html: '<span class="risk r' + n + '" title="Its loss limit is −' + l + '%">Risk: ' + n + "/5</span>" };
  }

  // ------------------------------------------------------------------ icons
  var P = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var ICONS = {
    coins: '<ellipse cx="7" cy="5" rx="4.5" ry="2" ' + P + '/><path d="M2.5 5v3c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V5" ' + P + "/>",
    trend: '<path d="M1.5 10 5 6.5l2.5 2.5L12.5 4" ' + P + '/><path d="M9.5 4h3v3" ' + P + "/>",
    gauge: '<path d="M2 10a5 5 0 1 1 10 0" ' + P + '/><path d="M7 10 9.5 6.5" ' + P + "/>",
    sort: '<path d="M4.5 5.5 7 3l2.5 2.5M4.5 8.5 7 11l2.5-2.5" ' + P + "/>",
    down: '<path d="M7 3v8m0 0L4 8m3 3 3-3" ' + P + "/>",
    back: '<path d="M11 7H3m0 0 3.5-3.5M3 7l3.5 3.5" ' + P + "/>",
    search: '<circle cx="6.2" cy="6.2" r="4.2" ' + P + '/><path d="m9.5 9.5 3 3" ' + P + "/>",
    external: '<path d="M5 9 10 4m0 0H6.5M10 4v3.5" ' + P + "/>",
    close: '<path d="M3.5 3.5l7 7M10.5 3.5l-7 7" ' + P + "/>",
    chev: '<path d="m5.5 3.5 3.5 3.5-3.5 3.5" ' + P + "/>",
  };
  function icon(name, size) {
    var s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 14 14" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  }

  // ------------------------------------------------------------ characters
  // Family's cast, one per mandate. The body (shape and colour) comes from the
  // address, so a mandate always looks the same; the face is its state, so a
  // glance says how it's doing.
  var INK = "#2a2a29";
  var BODY_COLORS = ["#1e9bff", "#1fc46b", "#ff4a1c", "#ffc53d"];
  var SHAPES = [
    // flower cloud
    function (c) {
      var petals = "";
      for (var k = 0; k < 8; k++) {
        var a = (k / 8) * Math.PI * 2;
        petals += '<circle cx="' + (50 + 27 * Math.cos(a)).toFixed(1) + '" cy="' + (48 + 27 * Math.sin(a)).toFixed(1) + '" r="17" fill="' + c + '"/>';
      }
      return petals + '<circle cx="50" cy="48" r="30" fill="' + c + '"/>';
    },
    // soft blob
    function (c) { return '<path d="M50 14c24-2 38 14 37 36s-16 38-39 36-36-16-35-38 15-32 37-34z" fill="' + c + '"/>'; },
    // tilted rounded square
    function (c) { return '<rect x="18" y="16" width="64" height="64" rx="17" fill="' + c + '" transform="rotate(-7 50 48)"/>'; },
    // rounded triangle
    function (c) { return '<path d="M50 12c6 0 9 4 13 11l24 46c5 10-1 17-11 17H24c-10 0-16-7-11-17l24-46c4-7 7-11 13-11z" fill="' + c + '"/>'; },
  ];
  function seed(address) {
    var h = 0, a = String(address || "").toLowerCase();
    for (var i = 2; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
    return h;
  }
  function face(mood) {
    var s = 'fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"';
    var dots = '<ellipse cx="41" cy="46" rx="4" ry="5.5" fill="' + INK + '"/><ellipse cx="59" cy="46" rx="4" ry="5.5" fill="' + INK + '"/>';
    if (mood === "happy") return '<path d="M35 47q6-7 12 0M53 47q6-7 12 0" ' + s + '/><path d="M41 58q9 9 18 0" ' + s + "/>";
    if (mood === "worried") return dots + '<path d="M42 64q8-7 16 0" ' + s + "/>";
    if (mood === "frozen") return dots + '<ellipse cx="50" cy="62" rx="4.5" ry="5" fill="' + INK + '"/>';
    if (mood === "asleep") return '<path d="M35 48h12M53 48h12" ' + s + '/><path d="M45 61h10" ' + s + '/>' +
      '<text x="74" y="22" font-family="Inter, sans-serif" font-weight="700" font-size="15" fill="#6f6e6c">z</text><text x="84" y="12" font-family="Inter, sans-serif" font-weight="700" font-size="11" fill="#6f6e6c">z</text>';
    if (mood === "meh") return dots + '<path d="M43 61h14" ' + s + "/>";
    return dots + '<path d="M43 59q7 6 14 0" ' + s + "/>"; // content
  }
  function mascot(r, cls) {
    var st = stateOf(r)[0];
    var h = seed(r.address);
    var d = dirOf(r.returnPct);
    var mood = st === "closed" ? "asleep" : st === "frozen" ? "frozen" : st === "expired" ? "meh" : d === "up" ? "happy" : d === "down" ? "worried" : "content";
    var color = st === "closed" ? "#dcd7cf" : st === "frozen" ? "#bfe3ff" : st === "expired" ? "#ffe3a3" : BODY_COLORS[(h >>> 3) % BODY_COLORS.length];
    var legs = '<path d="M40 84l-4 12M60 84l4 12" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>';
    var frost = st === "frozen" ? '<path d="M84 18v14M77 25h14M79 20l10 10M89 20l-10 10" stroke="#1e9bff" stroke-width="2.5" stroke-linecap="round"/>' : "";
    return '<span class="mascot' + (cls ? " " + cls : "") + '" aria-hidden="true"><svg viewBox="0 0 100 100">' + legs +
      SHAPES[h % SHAPES.length](color) + '<ellipse cx="36" cy="30" rx="8" ry="5" fill="#fff" opacity=".28" transform="rotate(-30 36 30)"/>' +
      face(mood) + frost + "</svg></span>";
  }

  // Family's doodles: coins, sparkles, a heart, cream circles.
  var DOODLE = {
    coin: '<svg viewBox="0 0 40 40"><ellipse cx="20" cy="22" rx="17" ry="16" fill="#f0a81c"/><ellipse cx="20" cy="19" rx="17" ry="16" fill="#ffc53d"/><path d="M11 30 27 7" stroke="#ffe08a" stroke-width="6" stroke-linecap="round"/></svg>',
    sparkle: '<svg viewBox="0 0 20 20"><path d="M10 0c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10z" fill="#ffc53d"/></svg>',
    sparkleBlue: '<svg viewBox="0 0 20 20"><path d="M10 0c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10z" fill="#5ec2ff"/></svg>',
    heart: '<svg viewBox="0 0 40 36"><path d="M20 34S2 23 2 12C2 5 7 1 12 1c4 0 7 2 8 5 1-3 4-5 8-5 5 0 10 4 10 11 0 11-18 22-18 22z" fill="#ff4a1c"/><ellipse cx="29" cy="10" rx="3" ry="2" fill="#fff" opacity=".5"/></svg>',
    dot: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#1fc46b"/></svg>',
    dotRed: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#ff4a1c"/></svg>',
    cream: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#f1ece4"/></svg>',
  };
  function doodle(kind, style, cls) {
    return '<span class="' + (cls || "float") + '" style="' + style + '" aria-hidden="true">' + DOODLE[kind].replace("<svg ", '<svg width="100%" height="100%" ') + "</span>";
  }

  // ------------------------------------------------------------- top bar
  var listeners = [];
  var MARK = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="8" fill="#1e9bff"/>' +
    '<ellipse cx="10" cy="12" rx="2" ry="2.7" fill="#2a2a29"/><ellipse cx="16" cy="12" rx="2" ry="2.7" fill="#2a2a29"/><path d="M10 17q3 2.5 6 0" fill="none" stroke="#2a2a29" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function topbar(page) {
    $("top").innerHTML =
      '<a class="wordmark" href="/">' + MARK + "Reins</a>" +
      '<nav class="pills" aria-label="Main">' +
      '<a href="/"' + (page === "explore" ? ' aria-current="page"' : "") + ">Explore</a>" +
      '<a href="/create.html"' + (page === "create" ? ' aria-current="page"' : "") + ">Create</a>" +
      '<a id="nav-explorer" href="#" target="_blank" rel="noopener">Explorer</a>' +
      "</nav>" +
      '<div class="top-r"><span class="net" id="net"><i></i><span id="net-text">Arc</span></span>' +
      '<button class="btn" id="wallet" type="button">Connect Wallet</button></div>';
    $("wallet").addEventListener("click", function () {
      connect().catch(function (err) { $("wallet").textContent = "No wallet"; $("wallet").title = W.explain(err); });
    });
    W.config().then(function (c) {
      $("nav-explorer").href = c.explorer;
      setNet(true, "Arc " + c.network);
    }).catch(function () { setNet(false, "Offline"); });
  }
  function setNet(ok, text) {
    $("net").classList.toggle("off", !ok);
    if (text) $("net-text").textContent = text;
  }
  async function connect() {
    var acct = await W.connect();
    $("wallet").textContent = short(acct);
    listeners.forEach(function (fn) { fn(acct); });
    return acct;
  }
  var onAccount = function (fn) { listeners.push(fn); };

  // --------------------------------------------------------------- series
  var SPAN = { "1d": 86400, "1w": 604800, "1m": 2592000 };
  var WHEN = { "1d": "past day", "1w": "past week", "1m": "past month", all: "since funding" };

  // Every point carries `index`: what $1 put in at funding is worth then.
  // The server chains it across deposits, withdrawals and unfreezes
  // (arena/returns.js), so a movement of money is never a gain or a loss and
  // an unfreeze can't wipe a loss off the record. A return over any period is
  // the ratio of two indexes.
  function growth(p) {
    if (typeof p.index === "number") return p.index;
    return p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null;
  }

  // Same chaining, for series built in the browser (several mandates summed).
  function chain(points) {
    var idx = 1, prev = null;
    return points.map(function (p) {
      var r = p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null;
      if (r !== null && prev !== null && !p.reset) idx *= r / prev;
      prev = r;
      return Object.assign({}, p, { index: idx });
    });
  }

  // a, z: windowed points { v, i }. pct from the indexes; diff is what the
  // period's return is worth on today's balance.
  function change(a, z) {
    var p, diff;
    if (a.i && z.i) { p = (z.i / a.i - 1) * 100; diff = z.v * (1 - a.i / z.i); }
    else { diff = z.v - a.v; p = a.v ? (diff / a.v) * 100 : 0; }
    return { diff: diff, pct: p, dir: Math.abs(diff) < 0.00005 ? "flat" : diff > 0 ? "up" : "down" };
  }

  // Cut a mandate's points to a range, carrying in the value held at its start.
  function windowed(points, range) {
    var now = Math.floor(Date.now() / 1000);
    var start = SPAN[range] ? now - SPAN[range] : points[0].t;
    var head = points[0];
    points.forEach(function (p) { if (p.t <= start) head = p; });
    var row = function (p, t) { return { t: t, v: p.equityUsd, b: p.baselineUsd, i: growth(p), events: t === p.t ? p.events || [] : [] }; };
    var out = [row(head, start)];
    points.forEach(function (p) { if (p.t > start) out.push(row(p, p.t)); });
    var tail = out[out.length - 1];
    if (tail.t < now) out.push({ t: now, v: tail.v, b: tail.b, i: tail.i, events: [] });
    return out;
  }

  // Return over each period, the leaderboard's columns.
  function periodReturns(points) {
    var out = {};
    ["1d", "1w", "1m", "all"].forEach(function (k) {
      if (!points || !points.length) { out[k] = null; return; }
      var s = windowed(points, k), a = s[0], z = s[s.length - 1];
      out[k] = a.i && z.i ? change(a, z).pct : null;
    });
    return out;
  }

  // Several mandates as one: at every moment, the sum of what each held,
  // chained the same way. A moment where any of them moved money is a reset.
  function combine(lists) {
    var ts = [];
    lists.forEach(function (l) { l.forEach(function (p) { ts.push(p.t); }); });
    ts = ts.filter(function (t, i, a) { return a.indexOf(t) === i; }).sort(function (a, b) { return a - b; });
    return chain(ts.map(function (t) {
      var v = 0, b = 0, events = [], reset = false;
      lists.forEach(function (l) {
        var last = null;
        l.forEach(function (p) { if (p.t <= t) last = p; });
        if (!last) return;
        v += last.equityUsd; b += last.baselineUsd;
        if (last.t === t) { events = events.concat(last.events || []); reset = reset || !!last.reset; }
      });
      return { t: t, equityUsd: v, baselineUsd: b, events: events, reset: reset };
    }));
  }

  // The chart's line: growth rebased to 1 at the start of the range.
  function index(series) {
    var base = null, last = 1;
    return series.map(function (s) {
      if (s.i) {
        if (base === null) base = s.i;
        last = s.i / base;
      }
      return last;
    });
  }
  // At least ±0.5% of room, so a 0.04% move looks like 0.04%.
  function domain(vals, around) {
    var c = around === undefined ? 1 : around, span = Math.abs(c) * 0.005 || 0.005;
    var lo = Math.min.apply(null, vals.concat([c - span])), hi = Math.max.apply(null, vals.concat([c + span]));
    var pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }
  function stepPath(series, vals, X, Y) {
    var d = "M" + X(series[0].t).toFixed(1) + " " + Y(vals[0]).toFixed(1);
    for (var i = 1; i < series.length; i++) d += " H" + X(series[i].t).toFixed(1) + " V" + Y(vals[i]).toFixed(1);
    return d;
  }
  var gradN = 0;
  function gradient(id, color, top) {
    return '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + color + '" stop-opacity="' + top + '"/>' +
      '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
  }

  // ------------------------------------------------------------ card chart
  // Chamber's card chart: a teal performance area, no axes.
  function areaSvg(points) {
    if (!points || !points.length) {
      return '<svg viewBox="0 0 300 150" aria-hidden="true"><path d="M0 75H300" stroke="#dcd7cf" stroke-width="2" stroke-dasharray="0.1 7" stroke-linecap="round"/></svg>';
    }
    var s = windowed(points, "all"), vals = index(s), dom = domain(vals);
    var t0 = s[0].t, t1 = s[s.length - 1].t > t0 ? s[s.length - 1].t : t0 + 1;
    var X = function (t) { return ((t - t0) / (t1 - t0)) * 300; };
    var Y = function (v) { return 8 + (1 - (v - dom[0]) / (dom[1] - dom[0])) * 134; };
    var d = stepPath(s, vals, X, Y), id = "ag" + gradN++;
    return '<svg viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">' + gradient(id, "#1e9bff", 0.28) +
      '<path d="' + d + ' V150 H0 Z" fill="url(#' + id + ')"/><path d="' + d + '" fill="none" stroke="#1e9bff" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
  }

  // ---------------------------------------------------------- detail chart
  /**
   * The vault chart. "performance" plots return (deposits and withdrawals
   * leave it flat); "value" plots equity in dollars. Point at it, or arrow
   * along it, and the headline reads that moment.
   *
   * @param {object} o  { plot, big, chg, when, ranges } elements
   */
  function Chart(o) {
    var points = null, range = "all", mode = "performance", st = null;
    var EV = { Frozen: "#ff4a1c", Deposited: "#2a2a29", Withdrawn: "#2a2a29", Traded: "#1e9bff", AgentChanged: "#2a2a29" };
    var stamp = function (t, withTime) {
      return new Date(t * 1000).toLocaleString("en-GB", withTime ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" });
    };

    function headline(s, i, whenText) {
      var c = change(st.first, s);
      if (mode === "performance") {
        o.big.innerHTML = '<span class="' + c.dir + '">' + pct(c.pct) + "</span>";
        o.chg.innerHTML = (c.diff < 0 ? "−" : "+") + esc(money(Math.abs(c.diff), 4)) + " on " + esc(money(s.v, 2));
      } else {
        o.big.innerHTML = bigMoneyHtml(s.v);
        o.chg.innerHTML = pctHtml(c.pct);
      }
      o.when.textContent = whenText;
    }

    function draw() {
      if (!points || !points.length) return;
      var s = windowed(points, range), first = s[0], end = s[s.length - 1];
      var vals = mode === "performance" ? index(s) : s.map(function (x) { return x.v; });
      var dom = domain(vals, mode === "performance" ? 1 : vals[0]);
      var Wd = Math.max(300, Math.round(o.plot.clientWidth || 640)), H = 240, TOP = 10, BOT = 206, RIGHT = 58;
      var t0 = first.t, t1 = end.t > t0 ? end.t : t0 + 1;
      var X = function (t) { return ((t - t0) / (t1 - t0)) * (Wd - RIGHT); };
      var Y = function (v) { return TOP + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (BOT - TOP); };
      var d = stepPath(s, vals, X, Y), id = "cg" + gradN++;
      var tick = function (v) { return mode === "performance" ? pct((v - 1) * 100, 2) : money(v, dom[1] - dom[0] < 0.5 ? 4 : 2); };
      var yl = "";
      for (var k = 0; k < 4; k++) {
        var v = dom[1] - ((dom[1] - dom[0]) * (k + 0.5)) / 4;
        yl += '<text x="' + Wd + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end" fill="#6f6e6c" font-size="12" font-family="Inter, sans-serif">' + tick(v) + "</text>";
      }
      var xl = "";
      var spanDays = (t1 - t0) / 86400;
      for (var n = 0; n < 5; n++) {
        var tt = t0 + ((t1 - t0) * n) / 4;
        xl += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (n === 0 ? "start" : n === 4 ? "end" : "middle") +
          '" fill="#6f6e6c" font-size="12" font-family="Inter, sans-serif">' + (n === 4 ? "Now" : stamp(tt, spanDays < 3)) + "</text>";
      }
      var marks = s.map(function (x, i) {
        var ev = (x.events || []).filter(function (e) { return e !== "now"; });
        if (!ev.length) return "";
        var c = ev.indexOf("Frozen") >= 0 ? EV.Frozen : EV[ev[0]] || "#1e9bff";
        return '<circle cx="' + X(x.t).toFixed(1) + '" cy="' + Y(vals[i]).toFixed(1) + '" r="3.5" fill="' + c + '" stroke="#fbfaf9" stroke-width="1.5"><title>' + esc(ev.join(" + ")) + "</title></circle>";
      }).join("");
      var y0 = Y(vals[0]).toFixed(1);
      o.plot.innerHTML =
        '<svg viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="' + (mode === "performance" ? "Return " : "Equity ") + esc(WHEN[range]) + ": " +
        pct(change(first, end).pct) + ', equity now ' + esc(money(end.v, 4)) + '">' + gradient(id, "#1e9bff", 0.3) + yl + xl +
        '<line x1="0" x2="' + (Wd - RIGHT) + '" y1="' + y0 + '" y2="' + y0 + '" stroke="#c9c5bd" stroke-width="1.5" stroke-dasharray="0.1 5" stroke-linecap="round"/>' +
        '<path d="' + d + " V" + BOT + ' H0 Z" fill="url(#' + id + ')"/>' +
        '<path d="' + d + '" fill="none" stroke="#1e9bff" stroke-width="1.8" stroke-linejoin="round"/>' + marks +
        '<g id="' + id + '-s" visibility="hidden"><line y1="' + TOP + '" y2="' + BOT + '" stroke="#c9c5bd"/><circle r="5" fill="#1e9bff" stroke="#fbfaf9" stroke-width="2"/></g></svg>';
      st = { s: s, vals: vals, X: X, Y: Y, W: Wd, first: first, end: end, idx: -1, g: $(id + "-s") };
      headline(end, s.length - 1, WHEN[range]);
    }

    function scrubTo(i) {
      if (!st || !st.s[i]) return;
      st.idx = i;
      var x = st.X(st.s[i].t).toFixed(1), y = st.Y(st.vals[i]).toFixed(1);
      st.g.setAttribute("visibility", "visible");
      st.g.querySelector("line").setAttribute("x1", x);
      st.g.querySelector("line").setAttribute("x2", x);
      st.g.querySelector("circle").setAttribute("cx", x);
      st.g.querySelector("circle").setAttribute("cy", y);
      var ev = (st.s[i].events || []).filter(function (e, j, a) { return e !== "now" && a.indexOf(e) === j; });
      headline(st.s[i], i, stamp(st.s[i].t, true) + (ev.length ? " · " + ev.join(" + ") : ""));
    }
    function scrubEnd() {
      if (!st || st.idx < 0) return;
      st.idx = -1;
      st.g.setAttribute("visibility", "hidden");
      headline(st.end, st.s.length - 1, WHEN[range]);
    }
    function idxAt(clientX) {
      var box = o.plot.getBoundingClientRect(), x = ((clientX - box.left) / box.width) * st.W, idx = 0;
      // A step chart holds each value until the next point: take the last at or before x.
      for (var i = 0; i < st.s.length; i++) if (st.X(st.s[i].t) <= x) idx = i;
      return idx;
    }
    o.plot.addEventListener("pointermove", function (ev) { if (st) scrubTo(idxAt(ev.clientX)); });
    o.plot.addEventListener("pointerleave", scrubEnd);
    o.plot.addEventListener("blur", scrubEnd);
    o.plot.addEventListener("keydown", function (ev) {
      if (!st) return;
      var last = st.s.length - 1, cur = st.idx < 0 ? last : st.idx;
      var keys = { ArrowLeft: Math.max(0, cur - 1), ArrowRight: Math.min(last, cur + 1), Home: 0, End: last };
      if (ev.key in keys) { scrubTo(keys[ev.key]); ev.preventDefault(); } else if (ev.key === "Escape") scrubEnd();
    });
    function pressGroup(group, attr, onPick) {
      Array.prototype.forEach.call(group.querySelectorAll("button"), function (b) {
        b.addEventListener("click", function () {
          Array.prototype.forEach.call(group.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", "false"); });
          b.setAttribute("aria-pressed", "true");
          onPick(b.getAttribute(attr));
        });
      });
    }
    pressGroup(o.ranges, "data-r", function (r) { range = r; draw(); });
    if (o.modes) pressGroup(o.modes, "data-m", function (m) { mode = m; draw(); });
    var timer = null;
    window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(function () { if (!st || st.idx < 0) draw(); }, 150); });

    return {
      set: function (p) { points = p; if (!st || st.idx < 0) draw(); }, // never yank the chart out from under a scrub
      empty: function (msg) { o.plot.innerHTML = '<div class="plot-empty">' + esc(msg) + "</div>"; },
    };
  }

  var RANGES = '<button type="button" data-r="1d" aria-pressed="false">1D</button><button type="button" data-r="1w" aria-pressed="false">1W</button>' +
    '<button type="button" data-r="1m" aria-pressed="false">1M</button><button type="button" data-r="all" aria-pressed="true">ALL</button>';

  async function getJson(path) {
    var res = await fetch(path);
    if (!res.ok) throw new Error("Couldn’t read " + path + " (" + res.status + ")");
    return res.json();
  }

  return {
    FLAT: FLAT, esc: esc, short: short, money: money, compact: compact, bigMoneyHtml: bigMoneyHtml, dirOf: dirOf,
    pct: pct, pctHtml: pctHtml, stateOf: stateOf, riskOf: riskOf, icon: icon, mascot: mascot, doodle: doodle, RANGES: RANGES,
    topbar: topbar, setNet: setNet, connect: connect, onAccount: onAccount,
    change: change, periodReturns: periodReturns, combine: combine, areaSvg: areaSvg, Chart: Chart, getJson: getJson,
  };
})();
