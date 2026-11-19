/* PokéMarges — suivi de revente Pokémon.
   Données : Supabase (une ligne par article, protégée par Row Level Security).
   Cotes des cartes : lues en direct chez TCGdex à chaque ouverture, donc toujours
   à jour. Valeurs du scellé : écrites par le Mac dans la table `prices`. */
(function () {
  "use strict";

  var CFG = window.POKEMARGES_CONFIG || {};
  var sb = null;
  var session = null;

  var SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];
  var KINDS = { carte: "Carte", gradee: "Gradée", scelle: "Scellé" };
  var STATUS = { stock: "En stock", gradation: "En gradation", livraison: "En livraison" };
  var PLATFORMS = ["Vinted", "eBay", "Cardmarket", "Voggt", "Autre"];
  var VIEWS = ["dashboard", "cartes", "gradees", "scelles", "ventes"];
  var TITLES = { dashboard: "Tableau de bord", cartes: "Mes cartes",
                 gradees: "Cartes gradées", scelles: "Mes scellés", ventes: "Journal des ventes" };

  var TCGDEX = "https://api.tcgdex.net/v2/fr/cards/";
  var PRICE_TTL = 12 * 3600 * 1000;   // les cotes Cardmarket bougent une fois par jour

  var state = { items: [], sales: [], prices: {}, history: [], cardPrices: {},
                ready: false, loadingPrices: false, lastSync: null };
  var index = null, indexLoading = null;
  var view = "dashboard";

  var eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  var eur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  function money(v, c) { return (c ? eur0 : eur).format(v || 0); }
  function signed(v) { return (v > 0 ? "+" : "") + money(v); }
  function pct(v) { return (v > 0 ? "+" : "") + v.toFixed(1).replace(".", ",") + " %"; }
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function fold(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }
  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item"; }
  function dayLabel(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }
  function sinceLabel(iso) {
    if (!iso) return null;
    var d = new Date(iso); if (isNaN(d)) return null;
    var h = (Date.now() - d.getTime()) / 36e5;
    if (h < 1.5) return "à l'instant";
    if (h < 36) return "il y a " + Math.round(h) + " h";
    return "il y a " + Math.round(h / 24) + " jours";
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function store(key, val) {
    try {
      if (val === undefined) { var r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------- connexion

  function showGate(message, isError) {
    document.getElementById("app").hidden = true;
    var gate = document.getElementById("gate");
    gate.hidden = false;
    if (message) {
      var m = document.getElementById("gate-msg");
      m.textContent = message;
      m.className = "hint" + (isError ? " err" : "");
    }
  }

  function initAuth() {
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
      showGate("Le site n'est pas encore relié à sa base. Renseigne config.js.", true);
      document.getElementById("gate-form").hidden = true;
      return;
    }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

    document.getElementById("gate-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = document.getElementById("gate-email").value.trim();
      if (!email) return;
      var btn = document.getElementById("gate-submit");
      btn.disabled = true; btn.textContent = "Envoi…";
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.href.split("#")[0] } })
        .then(function (res) {
          btn.disabled = false; btn.textContent = "Recevoir le lien";
          if (res.error) {
            document.getElementById("gate-msg").textContent = "Échec de l'envoi : " + res.error.message;
            document.getElementById("gate-msg").className = "hint err";
            return;
          }
          document.getElementById("gate-msg").textContent =
            "Lien envoyé à " + email + ". Ouvre-le depuis cet appareil ; il reste valable une heure.";
          document.getElementById("gate-msg").className = "hint";
        });
    });

    document.getElementById("signout").addEventListener("click", function () {
      sb.auth.signOut().then(function () { location.reload(); });
    });

    sb.auth.getSession().then(function (res) { applySession(res.data ? res.data.session : null); });
    sb.auth.onAuthStateChange(function (_evt, s) { applySession(s); });
  }

  function applySession(s) {
    var had = !!session;
    session = s;
    if (!s) { showGate(); return; }
    document.getElementById("gate").hidden = true;
    document.getElementById("app").hidden = false;
    if (!had) { render(); loadAll(); }
  }

  // ------------------------------------------------------------- chargement

  function loadAll() {
    Promise.all([
      sb.from("items").select("*"),
      sb.from("sales").select("*"),
      sb.from("prices").select("*"),
      sb.from("history").select("*").order("day", { ascending: true }).limit(400)
    ]).then(function (res) {
      state.items = (res[0].data || []);
      state.sales = (res[1].data || []);
      var pm = {};
      (res[2].data || []).forEach(function (p) { pm[p.item_id] = p; });
      state.prices = pm;
      state.history = (res[3].data || []);
      state.ready = true;
      state.lastSync = new Date().toISOString();
      render();
      refreshCardPrices();
    }).catch(function (err) {
      state.ready = true; render();
      document.getElementById("freshness").textContent = "Base injoignable : " + (err.message || err);
    });
  }

  /* Cotes des cartes, lues en direct chez TCGdex.
     Un cache local de 12 h évite de refaire 50 requêtes à chaque ouverture :
     Cardmarket ne met ses chiffres à jour qu'une fois par jour. */
  function refreshCardPrices(force) {
    var ids = state.items
      .filter(function (i) { return (i.kind || "carte") === "carte" && i.card_id && i.manual_value == null; })
      .map(function (i) { return i.card_id; });
    ids = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
    if (!ids.length) return;

    var now = Date.now(), todo = [];
    ids.forEach(function (id) {
      var cached = store("pm:price:" + id);
      if (cached && cached.v && !force && (now - cached.t) < PRICE_TTL) {
        state.cardPrices[id] = cached.v;
      } else { todo.push(id); }
    });
    render();
    if (!todo.length) return;

    state.loadingPrices = true; render();
    var done = 0;
    todo.forEach(function (id) {
      fetch(TCGDEX + encodeURIComponent(id))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (card) {
          var cm = card && card.pricing && card.pricing.cardmarket;
          if (cm) {
            /* Les champs « -holo » ne sont PAS la cote d'une carte holo : ils
               pointent une autre référence Cardmarket et sont incohérents
               (Dracaufeu Set de Base : trend 441,68 € contre -holo 123,63 €).
               On n'utilise que les champs de base. */
            var v = { trend: cm.trend, avg7: cm.avg7, avg30: cm.avg30, low: cm.low,
                      updated: cm.updated, source: "Tendance Cardmarket (TCGdex)" };
            state.cardPrices[id] = v;
            store("pm:price:" + id, { v: v, t: Date.now() });
          }
        })
        .catch(function () {})
        .then(function () {
          if (++done === todo.length) {
            state.loadingPrices = false;
            render();
            recordToday();
          }
        });
    });
  }

  // ------------------------------------------------------------ valorisation

  function unitValue(item) {
    if (item.manual_value != null) return Number(item.manual_value);
    if ((item.kind || "carte") === "carte" && item.card_id) {
      var p = state.cardPrices[item.card_id];
      if (!p) return null;
      var v = p.trend != null ? p.trend : (p.avg7 != null ? p.avg7 : p.avg30);
      return typeof v === "number" && v > 0 ? v : null;
    }
    var sp = state.prices[item.id];
    if (sp && sp.median != null) return Number(sp.median);
    return null;
  }

  function valueSource(item) {
    if (item.manual_value != null) return "valeur saisie à la main";
    if ((item.kind || "carte") === "carte") {
      var p = state.cardPrices[item.card_id];
      return p ? "Tendance Cardmarket, relevée " + (sinceLabel(p.updated) || "récemment") : null;
    }
    var sp = state.prices[item.id];
    return sp ? sp.source + " · " + sp.sample + " annonces" : null;
  }

  function inStock(i) { return (i.qty || 0) > 0; }
  function byKind(k) { return state.items.filter(function (i) { return (i.kind || "carte") === k; }); }
  function num(v) { return v == null ? null : Number(v); }

  function totals() {
    var parc = 0, investedStock = 0, unpriced = 0, units = 0;
    state.items.forEach(function (it) {
      var qty = it.qty || 0;
      if (it.buy_price != null) investedStock += Number(it.buy_price) * qty;
      if (qty > 0) {
        units += qty;
        var v = unitValue(it);
        if (v != null) parc += v * qty; else unpriced += qty;
      }
    });
    var cash = 0, marginDone = 0, investedSold = 0;
    state.sales.forEach(function (s) {
      var net = Number(s.gross || 0) - Number(s.fees || 0);
      var cost = Number(s.buy_price || 0) * (s.qty || 1);
      cash += net; investedSold += cost; marginDone += net - cost;
    });
    return { parc: parc, investedStock: investedStock, investedSold: investedSold,
             investedAll: investedStock + investedSold, cash: cash, marginDone: marginDone,
             latent: parc - investedStock, unpriced: unpriced, units: units };
  }

  /* Un relevé par jour, écrit à l'ouverture : la courbe se construit toute
     seule sans dépendre d'une tâche planifiée. */
  function recordToday() {
    if (!sb || !session) return;
    var t = totals();
    if (!t.units && !state.sales.length) return;
    sb.from("history").upsert({
      day: today(), user_id: session.user.id,
      parc: Math.round(t.parc * 100) / 100,
      invested: Math.round(t.investedStock * 100) / 100,
      cash: Math.round(t.cash * 100) / 100,
      margin: Math.round(t.marginDone * 100) / 100,
      units: t.units
    }, { onConflict: "user_id,day" }).then(function () {
      return sb.from("history").select("*").order("day", { ascending: true }).limit(400);
    }).then(function (r) { if (r && r.data) { state.history = r.data; render(); } })
      .catch(function () {});
  }

  // ------------------------------------------------------------------ rendu

  function render() {
    if (!session) return;
    document.getElementById("view-title").textContent = TITLES[view];
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn[data-view]"), function (b) {
      if (b.dataset.view === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });

    var actions = document.getElementById("view-actions");
    actions.textContent = "";
    if (view === "dashboard") {
      var r = el("button", "btn", "Rafraîchir les cotes");
      r.addEventListener("click", function () { refreshCardPrices(true); });
      actions.appendChild(r);
    }
    if (view === "cartes") actions.appendChild(addBtn("Ajouter une carte", openAddCard));
    if (view === "gradees") actions.appendChild(addBtn("Ajouter une gradée", function () { openAddManual("gradee"); }));
    if (view === "scelles") actions.appendChild(addBtn("Ajouter un scellé", function () { openAddManual("scelle"); }));
    if (view === "ventes") actions.appendChild(addBtn("Enregistrer une vente", function () { openSale(); }));

    var root = document.getElementById("view-root");
    root.textContent = "";
    if (!state.ready) { root.appendChild(loadingBlock()); renderFreshness(); return; }

    if (view === "dashboard") renderDashboard(root);
    else if (view === "ventes") renderSales(root);
    else renderStock(root, view === "cartes" ? "carte" : (view === "gradees" ? "gradee" : "scelle"));
    renderFreshness();
  }

  function addBtn(label, fn) {
    var b = el("button", "btn btn-accent");
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click", fn);
    return b;
  }
  function loadingBlock() {
    var g = el("div", "grid-kpi");
    for (var i = 0; i < 4; i++) {
      var k = el("div", "kpi"), s = el("div", "skeleton");
      s.style.cssText = "height:56px"; k.appendChild(s); g.appendChild(k);
    }
    return g;
  }
  function kpi(label, value, foot, variant) {
    var k = el("div", "kpi" + (variant ? " " + variant : ""));
    k.appendChild(el("span", "kpi-label", label));
    k.appendChild(el("span", "kpi-value num", value));
    var f = el("div", "kpi-foot");
    if (foot) f.appendChild(foot);
    k.appendChild(f);
    return k;
  }
  function pillNode(c, t) { return el("span", "pill " + c, t); }
  function chartCard(title, sub, body) {
    var c = el("section", "card"), h = el("div", "card-head"), l = el("div");
    l.appendChild(el("h2", null, title));
    if (sub) l.appendChild(el("p", "card-sub", sub));
    h.appendChild(l); c.appendChild(h); c.appendChild(body);
    return c;
  }

  function renderDashboard(root) {
    var t = totals();
    var kpis = el("div", "grid-kpi");
    kpis.appendChild(kpi("Valeur du parc", money(t.parc),
      t.unpriced ? pillNode("warn", t.unpriced + " sans valeur")
                 : el("span", null, t.units + " article" + (t.units > 1 ? "s" : "") + " en stock"), "kpi-hero"));
    kpis.appendChild(kpi("Capital investi", money(t.investedAll),
      el("span", null, money(t.investedStock) + " encore en stock")));
    kpis.appendChild(kpi("Trésorerie nette", money(t.cash),
      el("span", null, state.sales.length + " vente" + (state.sales.length > 1 ? "s" : ""))));
    var mg = kpi("Marge réalisée", state.sales.length ? signed(t.marginDone) : "—",
      state.sales.length && t.investedSold > 0
        ? pillNode(t.marginDone >= 0 ? "up" : "down", pct(t.marginDone / t.investedSold * 100))
        : el("span", null, "aucune vente"), "kpi-violet");
    kpis.appendChild(mg);
    root.appendChild(kpis);

    var lat = el("section", "card");
    var lh = el("div", "card-head"), lhl = el("div");
    lhl.appendChild(el("h2", null, "Marge latente sur le stock"));
    lhl.appendChild(el("p", "card-sub", "Ce que vaut le parc, moins ce qu'il a coûté"));
    lh.appendChild(lhl);
    var dir = t.latent > .009 ? "up" : (t.latent < -.009 ? "down" : "flat");
    lh.appendChild(el("div", "kpi-value num delta " + dir, t.investedStock > 0 ? signed(t.latent) : "—"));
    lat.appendChild(lh);
    if (t.investedStock > 0) {
      var bar = el("div", "mover-track"); bar.style.height = "10px";
      var fill = el("div", "mover-fill");
      fill.style.width = Math.max(2, Math.min(100, Math.abs(t.latent) / t.investedStock * 100)) + "%";
      fill.style.background = t.latent >= 0 ? "var(--good)" : "var(--bad)";
      bar.appendChild(fill); lat.appendChild(bar);
      lat.appendChild(el("p", "card-sub", money(t.investedStock) + " investis · " + money(t.parc)
        + " de valeur estimée · " + pct(t.latent / t.investedStock * 100)));
    } else {
      lat.appendChild(el("p", "card-sub", "Renseigne des prix d'achat pour suivre ta marge latente."));
    }
    root.appendChild(lat);

    var c1 = el("div", "cols");
    c1.appendChild(chartCard("Évolution de la valeur du parc", "Un relevé par jour, à chaque ouverture", valueChart()));
    c1.appendChild(chartCard("Répartition du capital", "Valeur du parc par catégorie", donut()));
    root.appendChild(c1);

    var c2 = el("div", "cols");
    c2.appendChild(chartCard("Top movers", "Écart entre achat et valeur estimée", movers()));
    c2.appendChild(chartCard("Alertes & prochaines étapes", null, alerts()));
    root.appendChild(c2);
    root.appendChild(sourceBanner());
  }

  function sourceBanner() {
    var b = el("div", "banner");
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    var d = el("div");
    d.innerHTML = "<strong>D'où viennent les valeurs.</strong> Cartes : tendance Cardmarket en euros, " +
      "lue en direct chez TCGdex, adossée aux ventes réelles. Scellés : médiane des annonces Vinted " +
      "comparables — ce sont des prix <em>demandés</em>, donc un ordre de grandeur. Gradées : saisie " +
      "manuelle, aucune source gratuite ne cote le gradé. Une valeur saisie prime toujours sur l'estimation.";
    b.appendChild(d);
    return b;
  }

  // ------------------------------------------------------------- graphiques

  function valueChart() {
    var host = el("div");
    var pts = state.history.slice().sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    if (pts.length < 2) {
      host.appendChild(emptyBlock("chart", "La courbe se construit jour après jour",
        pts.length === 1 ? "Premier relevé enregistré. Reviens demain pour le deuxième point."
                         : "Chaque ouverture du site enregistre la valeur du parc du jour."));
      return host;
    }
    var W = 560, H = 190, PL = 50, PR = 12, PT = 14, PB = 26;
    var vals = pts.map(function (p) { return Number(p.parc) || 0; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1) { max += 1; min = Math.max(0, min - 1); }
    var pad = (max - min) * .12; min = Math.max(0, min - pad); max += pad;
    function X(i) { return PL + (i / (pts.length - 1)) * (W - PL - PR); }
    function Y(v) { return PT + (1 - (v - min) / (max - min)) * (H - PT - PB); }

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", role: "img",
      "aria-label": "Évolution de la valeur du parc" });
    svg.style.display = "block"; svg.style.overflow = "visible";
    [0, .5, 1].forEach(function (f) {
      var v = min + (max - min) * f, y = Y(v);
      svg.appendChild(svgEl("line", { x1: PL, x2: W - PR, y1: y, y2: y, stroke: "var(--line)", "stroke-width": 1 }));
      var tx = svgEl("text", { x: PL - 8, y: y + 4, "text-anchor": "end", fill: "var(--text-mute)", "font-size": 10 });
      tx.textContent = money(v, true); svg.appendChild(tx);
    });
    var line = "";
    pts.forEach(function (p, i) { line += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(vals[i]).toFixed(1) + " "; });
    var area = line + "L" + X(pts.length - 1).toFixed(1) + " " + (H - PB) + " L" + PL + " " + (H - PB) + " Z";
    var defs = svgEl("defs", {});
    var g = svgEl("linearGradient", { id: "pg", x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl("stop", { offset: "0%", "stop-color": "var(--accent)", "stop-opacity": .26 }));
    g.appendChild(svgEl("stop", { offset: "100%", "stop-color": "var(--accent)", "stop-opacity": 0 }));
    defs.appendChild(g); svg.appendChild(defs);
    svg.appendChild(svgEl("path", { d: area, fill: "url(#pg)", stroke: "none" }));
    svg.appendChild(svgEl("path", { d: line.trim(), fill: "none", stroke: "var(--accent)", "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round" }));
    [0, pts.length - 1].forEach(function (i) {
      var tx = svgEl("text", { x: X(i), y: H - 8, fill: "var(--text-mute)", "font-size": 10,
        "text-anchor": i === 0 ? "start" : "end" });
      tx.textContent = dayLabel(pts[i].day); svg.appendChild(tx);
    });
    svg.appendChild(svgEl("circle", { cx: X(pts.length - 1), cy: Y(vals[vals.length - 1]), r: 5,
      fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));

    var hover = svgEl("g", { opacity: 0 });
    var vline = svgEl("line", { y1: PT, y2: H - PB, stroke: "var(--text-mute)", "stroke-width": 1, "stroke-dasharray": "3 3" });
    var dot = svgEl("circle", { r: 4.5, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 });
    hover.appendChild(vline); hover.appendChild(dot); svg.appendChild(hover);
    var tip = el("div", "pill");
    tip.style.cssText = "position:absolute;pointer-events:none;opacity:0;transform:translate(-50%,-130%);white-space:nowrap;background:var(--surface-3);color:var(--text)";
    var wrap = el("div"); wrap.style.position = "relative";
    wrap.appendChild(svg); wrap.appendChild(tip); host.appendChild(wrap);
    svg.addEventListener("pointermove", function (ev) {
      var box = svg.getBoundingClientRect();
      var i = Math.round(((ev.clientX - box.left) / box.width * W - PL) / ((W - PL - PR) / (pts.length - 1)));
      i = Math.max(0, Math.min(pts.length - 1, i));
      var x = X(i), y = Y(vals[i]);
      vline.setAttribute("x1", x); vline.setAttribute("x2", x);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);
      hover.setAttribute("opacity", 1);
      tip.textContent = dayLabel(pts[i].day) + " · " + money(vals[i]);
      tip.style.left = (x / W * 100) + "%"; tip.style.top = (y / H * 100) + "%"; tip.style.opacity = 1;
    });
    svg.addEventListener("pointerleave", function () { hover.setAttribute("opacity", 0); tip.style.opacity = 0; });
    return host;
  }

  function donut() {
    var host = el("div"), buckets = {};
    state.items.forEach(function (it) {
      if (!inStock(it)) return;
      var v = unitValue(it); if (v == null) return;
      var k = KINDS[it.kind || "carte"] || "Carte";
      buckets[k] = (buckets[k] || 0) + v * (it.qty || 1);
    });
    var rows = Object.keys(buckets).map(function (k) { return { name: k, value: buckets[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
    if (!rows.length) {
      host.appendChild(emptyBlock("pie", "Rien à répartir", "Dès qu'un article a une valeur estimée, sa catégorie apparaît ici."));
      return host;
    }
    var total = rows.reduce(function (s, r) { return s + r.value; }, 0) || 1;
    var S = 150, R = 62, TH = 20, C = S / 2;
    var svg = svgEl("svg", { viewBox: "0 0 " + S + " " + S, width: S, height: S, role: "img",
      "aria-label": "Répartition de la valeur du parc par catégorie" });
    svg.style.flex = "none";
    var a = -Math.PI / 2;
    rows.forEach(function (r, i) {
      var sweep = r.value / total * Math.PI * 2, gap = rows.length > 1 ? .035 : 0;
      r.color = "var(" + SERIES[i % SERIES.length] + ")";
      if (a + sweep - gap / 2 > a + gap / 2) {
        svg.appendChild(svgEl("path", { d: arc(C, C, R, a + gap / 2, a + sweep - gap / 2),
          fill: "none", stroke: r.color, "stroke-width": TH }));
      }
      a += sweep;
    });
    var mid = svgEl("text", { x: C, y: C - 2, "text-anchor": "middle", fill: "var(--text)", "font-size": 15, "font-weight": 700 });
    mid.textContent = money(total, true); svg.appendChild(mid);
    var sub = svgEl("text", { x: C, y: C + 14, "text-anchor": "middle", fill: "var(--text-mute)", "font-size": 9.5 });
    sub.textContent = "valeur du parc"; svg.appendChild(sub);
    var row = el("div", "donut-row"); row.appendChild(svg);
    var legend = el("div", "legend");
    rows.forEach(function (r) {
      var li = el("div", "legend-item"), sw = el("span", "swatch");
      sw.style.background = r.color; li.appendChild(sw);
      li.appendChild(el("span", "legend-name", r.name));
      li.appendChild(el("span", "legend-val", money(r.value, true)));
      li.title = r.name + " · " + money(r.value) + " (" + Math.round(r.value / total * 100) + " %)";
      legend.appendChild(li);
    });
    row.appendChild(legend); host.appendChild(row);
    return host;
  }
  function arc(cx, cy, r, a0, a1) {
    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    return "M" + x0.toFixed(2) + " " + y0.toFixed(2) + " A" + r + " " + r + " 0 " +
      ((a1 - a0) > Math.PI ? 1 : 0) + " 1 " + x1.toFixed(2) + " " + y1.toFixed(2);
  }

  function movers() {
    var host = el("div"), rows = [];
    state.items.forEach(function (it) {
      if (!inStock(it) || it.buy_price == null) return;
      var v = unitValue(it), buy = Number(it.buy_price);
      if (v == null || buy <= 0) return;
      rows.push({ name: it.name, gain: (v - buy) * (it.qty || 1), pct: (v - buy) / buy * 100 });
    });
    if (!rows.length) {
      host.appendChild(emptyBlock("bars", "Pas encore de mouvement",
        "Il faut un prix d'achat et une valeur estimée pour calculer un écart."));
      return host;
    }
    rows.sort(function (a, b) { return Math.abs(b.gain) - Math.abs(a.gain); });
    rows = rows.slice(0, 5);
    var peak = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.gain); })) || 1;
    var list = el("div", "movers");
    rows.forEach(function (r) {
      var up = r.gain >= 0, m = el("div", "mover");
      m.appendChild(el("span", "mover-name", r.name));
      m.appendChild(el("span", "mover-val delta " + (up ? "up" : "down"), signed(r.gain) + "  " + pct(r.pct)));
      var track = el("div", "mover-track"), fill = el("div", "mover-fill");
      fill.style.width = Math.max(3, Math.abs(r.gain) / peak * 100) + "%";
      fill.style.background = up ? "var(--good)" : "var(--bad)";
      track.appendChild(fill); m.appendChild(track); list.appendChild(m);
    });
    host.appendChild(list);
    return host;
  }

  function alerts() {
    var host = el("div", "alerts"), out = [], t = totals();
    if (state.loadingPrices) out.push(["info", "Cotes en cours de mise à jour", "Lecture en direct chez TCGdex."]);
    if (t.unpriced > 0) out.push(["warn", t.unpriced + " article" + (t.unpriced > 1 ? "s" : "") + " sans valeur",
      "Les cartes se valorisent toutes seules. Pour une gradée, saisis la valeur ; pour un scellé, lance l'estimation depuis le Mac."]);
    var noBuy = state.items.filter(function (i) { return inStock(i) && i.buy_price == null; }).length;
    if (noBuy) out.push(["info", noBuy + " article" + (noBuy > 1 ? "s" : "") + " sans prix d'achat",
      "Sans prix d'achat, ni la marge latente ni la marge réalisée ne sont calculables."]);
    var pending = state.items.filter(function (i) { return i.status && i.status !== "stock"; });
    if (pending.length) out.push(["info", pending.length + " article" + (pending.length > 1 ? "s" : "") + " immobilisé" + (pending.length > 1 ? "s" : ""),
      pending.map(function (i) { return i.name + " (" + (STATUS[i.status] || i.status).toLowerCase() + ")"; }).join(", ") + "."]);
    var sealedStale = Object.keys(state.prices).map(function (k) { return state.prices[k].updated_at; }).filter(Boolean).sort();
    if (sealedStale.length) {
      var age = (Date.now() - new Date(sealedStale[0]).getTime()) / 36e5;
      if (age > 72) out.push(["warn", "Valeurs de scellés anciennes",
        "La plus ancienne date de " + Math.round(age / 24) + " jours. Relance l'estimation depuis le Mac."]);
    }
    if (!out.length) out.push(["ok", "Tout est à jour", "Aucune alerte."]);
    var ICON = {
      ok: '<path d="M20 6 9 17l-5-5"/>',
      warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'
    };
    out.forEach(function (a) {
      var n = el("div", "alert " + a[0]);
      n.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[a[0]] + '</svg>';
      var d = el("div");
      d.appendChild(el("b", null, a[1]));
      d.appendChild(document.createTextNode(" — " + a[2]));
      n.appendChild(d); host.appendChild(n);
    });
    return host;
  }

  // ------------------------------------------------------------- vues stock

  function renderStock(root, kind) {
    var items = byKind(kind), stock = items.filter(inStock);
    var value = 0, invested = 0, units = 0;
    stock.forEach(function (it) {
      var v = unitValue(it), q = it.qty || 1;
      units += q;
      if (v != null) value += v * q;
      if (it.buy_price != null) invested += Number(it.buy_price) * q;
    });
    var kpis = el("div", "grid-kpi");
    kpis.appendChild(kpi("Valeur totale", money(value), el("span", null, units + " unité" + (units > 1 ? "s" : "")), "kpi-hero"));
    kpis.appendChild(kpi("Prix d'achat", money(invested), el("span", null, items.length + " référence" + (items.length > 1 ? "s" : ""))));
    var lat = value - invested;
    var lk = kpi("Marge latente", invested > 0 ? signed(lat) : "—",
      invested > 0 ? pillNode(lat >= 0 ? "up" : "down", pct(lat / invested * 100)) : el("span", null, "saisis les prix d'achat"));
    lk.querySelector(".kpi-value").classList.add("delta", lat >= 0 ? "up" : "down");
    kpis.appendChild(lk);
    root.appendChild(kpis);

    var card = el("section", "card"), head = el("div", "card-head"), hl = el("div");
    hl.appendChild(el("h2", null, "Mon stock " + (kind === "carte" ? "de cartes" : (kind === "gradee" ? "gradé" : "scellé"))));
    hl.appendChild(el("p", "card-sub", items.length + " référence" + (items.length > 1 ? "s" : "")));
    head.appendChild(hl); card.appendChild(head);

    if (!items.length) {
      card.appendChild(emptyBlock(kind === "scelle" ? "box" : "cards",
        kind === "carte" ? "Aucune carte" : (kind === "gradee" ? "Aucune carte gradée" : "Aucun produit scellé"),
        kind === "carte" ? "Cherche une carte par son nom français parmi 22 342 références ; sa cote Cardmarket est lue en direct."
          : (kind === "gradee" ? "Saisis le nom, le gradeur et la note. La valeur est à renseigner : aucune source gratuite ne cote le gradé."
             : "Saisis le nom du produit. Sa valeur est estimée depuis les annonces Vinted par le script du Mac."),
        function () { kind === "carte" ? openAddCard() : openAddManual(kind); }));
      root.appendChild(card); return;
    }

    var cols = kind === "gradee"
      ? [["Carte", ""], ["Note", ""], ["Statut", ""], ["Qté", "n"], ["Achat", "n"], ["Valeur", "n"], ["Marge", "n"], ["", "n"]]
      : [[kind === "carte" ? "Carte" : "Produit", ""], ["Qté", "n"], ["Achat", "n"], ["Valeur", "n"], ["Marge", "n"], ["", "n"]];
    var wrap = el("div", "table-wrap"), table = el("table"), thead = el("thead"), hr = el("tr");
    cols.forEach(function (c) { hr.appendChild(el("th", c[1], c[0])); });
    thead.appendChild(hr); table.appendChild(thead);

    var tbody = el("tbody");
    items.slice().sort(function (a, b) {
      return (unitValue(b) || 0) * (b.qty || 1) - (unitValue(a) || 0) * (a.qty || 1);
    }).forEach(function (it) {
      var tr = el("tr"), q = it.qty || 0, v = unitValue(it);
      var tdName = el("td");
      tdName.appendChild(el("span", "item-name", it.name));
      var bits = [];
      if (it.set_name) bits.push(it.set_name);
      if (it.local_id) bits.push("n° " + it.local_id);
      if (it.condition) bits.push(it.condition);
      if (!q) bits.push("écoulé");
      if (bits.length) tdName.appendChild(el("span", "item-meta", bits.join(" · ")));
      tr.appendChild(tdName);

      if (kind === "gradee") {
        tr.appendChild(el("td", null, [it.grader, it.grade].filter(Boolean).join(" ") || "—"));
        var tdSt = el("td");
        tdSt.appendChild(el("span", "pill" + (it.status && it.status !== "stock" ? " info" : ""), STATUS[it.status || "stock"]));
        tr.appendChild(tdSt);
      }
      tr.appendChild(el("td", "n num", String(q)));
      tr.appendChild(el("td", "n num", it.buy_price != null ? money(Number(it.buy_price)) : "—"));

      var tdVal = el("td", "n num");
      if (v != null) {
        tdVal.appendChild(document.createTextNode(money(v)));
        var src = valueSource(it); if (src) tdVal.title = src;
      } else { tdVal.appendChild(el("span", "pill", state.loadingPrices ? "…" : "en attente")); }
      tr.appendChild(tdVal);

      var tdM = el("td", "n num");
      if (v != null && it.buy_price != null && Number(it.buy_price) > 0 && q > 0) {
        var gg = (v - Number(it.buy_price)) * q;
        tdM.className = "n num delta " + (gg >= 0 ? "up" : "down");
        tdM.textContent = signed(gg);
      } else tdM.textContent = "—";
      tr.appendChild(tdM);

      var tdA = el("td", "n"); tdA.style.whiteSpace = "nowrap";
      if (q > 0) tdA.appendChild(iconBtn("Vendre " + it.name, "M3 17l5-6 4 4 7-8M16 7h4v4", function () { openSale(it.id); }));
      tdA.appendChild(iconBtn("Modifier " + it.name, "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", function () { openEdit(it); }));
      var d = iconBtn("Supprimer " + it.name, "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6", function () { removeItem(it); });
      d.classList.add("danger"); tdA.appendChild(d);
      tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); wrap.appendChild(table); card.appendChild(wrap);
    root.appendChild(card); root.appendChild(sourceBanner());
  }

  function iconBtn(label, path, fn) {
    var b = el("button", "icon-btn");
    b.title = label; b.setAttribute("aria-label", label);
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
    b.addEventListener("click", fn);
    return b;
  }

  function renderSales(root) {
    var t = totals(), kpis = el("div", "grid-kpi");
    kpis.appendChild(kpi("Trésorerie nette", money(t.cash), el("span", null, "brut moins frais"), "kpi-hero"));
    kpis.appendChild(kpi("Marge réalisée", state.sales.length ? signed(t.marginDone) : "—",
      t.investedSold > 0 ? pillNode(t.marginDone >= 0 ? "up" : "down", pct(t.marginDone / t.investedSold * 100)) : null));
    kpis.appendChild(kpi("Ventes", String(state.sales.length), el("span", null, "enregistrées")));
    root.appendChild(kpis);

    var card = el("section", "card"), head = el("div", "card-head"), hl = el("div");
    hl.appendChild(el("h2", null, "Historique"));
    hl.appendChild(el("p", "card-sub", "Chaque vente retire la quantité vendue du stock"));
    head.appendChild(hl); card.appendChild(head);

    if (!state.sales.length) {
      card.appendChild(emptyBlock("chart", "Aucune vente",
        "Enregistre une vente pour suivre ta trésorerie et ta marge réelle, frais déduits.",
        function () { openSale(); }));
      root.appendChild(card); return;
    }
    var wrap = el("div", "table-wrap"), table = el("table"), thead = el("thead"), hr = el("tr");
    [["Date", ""], ["Produit", ""], ["Plateforme", ""], ["Qté", "n"], ["Brut", "n"], ["Frais", "n"], ["Net", "n"], ["Marge", "n"], ["", "n"]]
      .forEach(function (c) { hr.appendChild(el("th", c[1], c[0])); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    state.sales.slice().sort(function (a, b) { return (b.sold_on || "") < (a.sold_on || "") ? -1 : 1; }).forEach(function (s) {
      var net = Number(s.gross || 0) - Number(s.fees || 0);
      var cost = Number(s.buy_price || 0) * (s.qty || 1), margin = net - cost;
      var tr = el("tr");
      tr.appendChild(el("td", null, dayLabel(s.sold_on) || s.sold_on || "—"));
      var tdN = el("td");
      tdN.appendChild(el("span", "item-name", s.name || "—"));
      if (Number(s.buy_price) > 0) tdN.appendChild(el("span", "item-meta", "acheté " + money(Number(s.buy_price)) + " l'unité"));
      tr.appendChild(tdN);
      var tdP = el("td"); tdP.appendChild(el("span", "pill", s.platform || "Autre")); tr.appendChild(tdP);
      tr.appendChild(el("td", "n num", String(s.qty || 1)));
      tr.appendChild(el("td", "n num", money(Number(s.gross))));
      tr.appendChild(el("td", "n num", Number(s.fees) ? "−" + money(Number(s.fees)) : "—"));
      tr.appendChild(el("td", "n num", money(net)));
      var tdM = el("td", "n num delta " + (margin >= 0 ? "up" : "down"));
      tdM.textContent = Number(s.buy_price) > 0 ? signed(margin) : "—";
      tr.appendChild(tdM);
      var tdA = el("td", "n");
      var d = iconBtn("Supprimer la vente", "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6", function () { removeSale(s); });
      d.classList.add("danger"); tdA.appendChild(d); tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); wrap.appendChild(table); card.appendChild(wrap);
    root.appendChild(card);
  }

  function renderFreshness() {
    var node = document.getElementById("freshness");
    if (!state.ready) { node.textContent = "Chargement…"; return; }
    if (state.loadingPrices) { node.textContent = "Mise à jour des cotes…"; return; }
    var stamps = Object.keys(state.cardPrices).map(function (k) { return state.cardPrices[k].updated; }).filter(Boolean).sort();
    if (!stamps.length && !state.items.length) { node.textContent = "Prêt. Ajoute ton premier article."; return; }
    node.textContent = stamps.length
      ? "Cotes Cardmarket relevées " + (sinceLabel(stamps[stamps.length - 1]) || "récemment") + " · lues en direct"
      : "Valeurs en attente de récupération";
  }

  var ART = {
    cards: '<path d="M3 3h13v18H3z"/><path d="M8 21h11a2 2 0 0 0 2-2V7"/>',
    chart: '<path d="M3 17l5-6 4 4 7-8"/><path d="M3 21h18"/>',
    pie: '<path d="M21 12a9 9 0 1 1-9-9v9z"/>',
    bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8"/>'
  };
  function emptyBlock(art, title, text, onAdd) {
    var box = el("div", "empty"), a = el("div", "empty-art");
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ART[art] + '</svg>';
    box.appendChild(a);
    box.appendChild(el("h3", null, title));
    box.appendChild(el("p", null, text));
    if (onAdd) { var b = el("button", "btn btn-accent", "Ajouter maintenant"); b.addEventListener("click", onAdd); box.appendChild(b); }
    return box;
  }

  // --------------------------------------------------------- index de cartes

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (indexLoading) return indexLoading;
    indexLoading = fetch("cards-fr.json").then(function (r) {
      if (!r.ok) throw new Error("index indisponible"); return r.json();
    }).then(function (d) { index = d; return d; });
    return indexLoading;
  }
  function searchCards(q, limit) {
    if (!index) return [];
    var needle = fold(q);
    if (needle.length < 2) return [];
    var exact = [], starts = [], inside = [];
    for (var i = 0; i < index.cards.length; i++) {
      var f = fold(index.cards[i][0]);
      if (f === needle) exact.push(index.cards[i]);
      else if (f.indexOf(needle) === 0) starts.push(index.cards[i]);
      else if (inside.length < limit && f.indexOf(needle) > 0) inside.push(index.cards[i]);
      if (exact.length + starts.length >= limit * 2) break;
    }
    return exact.concat(starts, inside).slice(0, limit).map(function (c) {
      var cut = c[1].lastIndexOf("-");
      var setId = c[1].slice(0, cut), localId = c[1].slice(cut + 1), s = index.sets[setId];
      return { id: c[1], card_id: c[1], name: c[0], set_id: setId, local_id: localId,
               set_name: s ? s[0] : setId, setTotal: s ? s[2] : 0 };
    });
  }

  // -------------------------------------------------------------- modales

  function modal(title) {
    var layer = document.getElementById("modal-layer");
    layer.textContent = ""; layer.hidden = false;
    var m = el("div", "modal"), head = el("div", "modal-head");
    head.appendChild(el("h2", null, title));
    var close = el("button", "icon-btn");
    close.setAttribute("aria-label", "Fermer");
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    close.addEventListener("click", closeModal);
    head.appendChild(close); m.appendChild(head);
    var body = el("div", "modal-body"); m.appendChild(body); layer.appendChild(m);
    layer.onclick = function (e) { if (e.target === layer) closeModal(); };
    document.addEventListener("keydown", escClose);
    return body;
  }
  function escClose(e) { if (e.key === "Escape") closeModal(); }
  function closeModal() {
    var layer = document.getElementById("modal-layer");
    layer.hidden = true; layer.textContent = "";
    document.removeEventListener("keydown", escClose);
  }
  function field(id, label, type, ph, val) {
    var f = el("div", "field"), l = el("label", null, label);
    l.setAttribute("for", id); f.appendChild(l);
    var i = el("input"); i.id = id; i.type = type || "text";
    if (type === "number") { i.min = "0"; i.step = id.indexOf("qty") >= 0 ? "1" : "0.01"; }
    if (ph) i.placeholder = ph;
    if (val != null) i.value = val;
    f.appendChild(i); return f;
  }
  function selectField(id, label, options, val) {
    var f = el("div", "field"), l = el("label", null, label);
    l.setAttribute("for", id); f.appendChild(l);
    var s = el("select"); s.id = id;
    options.forEach(function (o) {
      var opt = el("option", null, o[1]); opt.value = o[0];
      if (val != null && String(val) === String(o[0])) opt.selected = true;
      s.appendChild(opt);
    });
    f.appendChild(s); return f;
  }
  function v(id) { var n = document.getElementById(id); return n ? n.value : ""; }
  function numVal(id) { var x = parseFloat(v(id).replace(",", ".")); return isFinite(x) ? x : null; }
  function intVal(id, d) { var x = parseInt(v(id), 10); return isFinite(x) && x >= 0 ? x : d; }

  function openAddCard() {
    var body = modal("Ajouter une carte");
    var f = el("div", "field"), l = el("label", null, "Nom de la carte (en français)");
    l.setAttribute("for", "q-card"); f.appendChild(l);
    var input = el("input"); input.id = "q-card"; input.type = "search"; input.autocomplete = "off";
    input.placeholder = "Dracaufeu, Gardevoir, Ectoplasma…";
    f.appendChild(input); body.appendChild(f);
    var results = el("div", "results"); body.appendChild(results);
    var form = el("div"); form.hidden = true; body.appendChild(form);
    results.appendChild(el("p", "hint", "Tape au moins deux lettres."));
    input.focus();
    var timer = null;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        results.textContent = ""; form.hidden = true;
        if (!index) { results.appendChild(el("p", "hint", "Chargement de l'index…")); return; }
        var hits = searchCards(input.value, 25);
        if (!hits.length) {
          results.appendChild(el("p", "hint", fold(input.value).length < 2
            ? "Tape au moins deux lettres." : "Aucune carte trouvée pour « " + input.value + " »."));
          return;
        }
        hits.forEach(function (h) {
          var b = el("button", "result"), left = el("div");
          left.appendChild(el("div", "result-name", h.name));
          left.appendChild(el("div", "result-meta", h.set_name + (h.local_id ? " · n° " + h.local_id + (h.setTotal ? "/" + h.setTotal : "") : "")));
          b.appendChild(left);
          b.addEventListener("click", function () { cardForm(h, results, form); });
          results.appendChild(b);
        });
      }, 120);
    });
    loadIndex().catch(function () {
      results.textContent = "";
      results.appendChild(el("p", "hint err", "L'index des cartes n'a pas pu être chargé. Recharge la page."));
    });
  }

  function cardForm(h, results, form) {
    results.textContent = "";
    var picked = el("div", "result"); picked.setAttribute("aria-selected", "true");
    var left = el("div");
    left.appendChild(el("div", "result-name", h.name));
    left.appendChild(el("div", "result-meta", h.set_name + (h.local_id ? " · n° " + h.local_id : "")));
    picked.appendChild(left); results.appendChild(picked);
    form.hidden = false; form.textContent = "";
    var row = el("div", "field-row");
    row.appendChild(field("f-buy", "Prix payé l'unité (€)", "number", "0,00"));
    row.appendChild(field("f-qty", "Quantité", "number", "1", "1"));
    form.appendChild(row);
    form.appendChild(selectField("f-cond", "État",
      [["", "Non précisé"], ["Neuve", "Neuve"], ["Très bon état", "Très bon état"],
       ["Bon état", "Bon état"], ["Satisfaisant", "Satisfaisant"]]));
    var save = el("button", "btn btn-accent", "Ajouter au stock");
    save.style.width = "100%";
    save.addEventListener("click", function () {
      var row2 = { id: h.card_id, kind: "carte", card_id: h.card_id, name: h.name,
        set_id: h.set_id, set_name: h.set_name, local_id: h.local_id,
        qty: intVal("f-qty", 1) || 1, condition: v("f-cond") || null, status: "stock" };
      var b = numVal("f-buy"); if (b != null) row2.buy_price = b;
      saveItem(row2, save);
    });
    form.appendChild(save);
    form.appendChild(el("p", "hint", "La cote Cardmarket est lue dès l'ajout."));
    var first = document.getElementById("f-buy"); if (first) first.focus();
  }

  function openAddManual(kind, existing) {
    var isGrade = kind === "gradee";
    var body = modal(existing ? "Modifier" : (isGrade ? "Ajouter une carte gradée" : "Ajouter un produit scellé"));
    var it = existing || {};
    body.appendChild(field("f-name", isGrade ? "Nom de la carte" : "Nom du produit", "text",
      isGrade ? "Dracaufeu Set de Base" : "ETB Forces Temporelles", it.name));
    if (isGrade) {
      var r0 = el("div", "field-row");
      r0.appendChild(selectField("f-grader", "Gradeur",
        [["", "—"], ["PSA", "PSA"], ["PCA", "PCA"], ["CGC", "CGC"], ["BGS", "BGS"], ["SGC", "SGC"], ["Autre", "Autre"]], it.grader));
      r0.appendChild(field("f-grade", "Note", "text", "10", it.grade));
      body.appendChild(r0);
      body.appendChild(selectField("f-status", "Statut",
        [["stock", "En stock"], ["gradation", "En gradation"], ["livraison", "En livraison"]], it.status || "stock"));
    }
    var row = el("div", "field-row-3");
    row.appendChild(field("f-buy", "Prix d'achat l'unité (€)", "number", "0,00", it.buy_price));
    row.appendChild(field("f-qty", "Quantité", "number", "1", it.qty != null ? it.qty : 1));
    row.appendChild(field("f-value", "Valeur l'unité (€)", "number", isGrade ? "obligatoire" : "auto", it.manual_value));
    body.appendChild(row);
    body.appendChild(el("p", "hint", isGrade
      ? "La valeur est à saisir : aucune source gratuite ne cote le gradé. Une PSA 10 vaut un multiple de la cote brute."
      : "Laisse la valeur vide pour qu'elle soit estimée depuis les annonces Vinted. Une valeur saisie ici prime sur l'estimation."));
    var save = el("button", "btn btn-accent", existing ? "Enregistrer" : "Ajouter au stock");
    save.style.width = "100%"; save.style.marginTop = "6px";
    save.addEventListener("click", function () {
      var name = v("f-name").trim();
      if (!name) { save.parentNode.appendChild(el("p", "hint err", "Il faut un nom.")); return; }
      var row2 = {
        id: existing ? existing.id : (kind + "-" + slug(name) + "-" + Date.now().toString(36)),
        kind: kind, name: name, qty: intVal("f-qty", 1),
        status: isGrade ? (v("f-status") || "stock") : "stock"
      };
      if (isGrade) { row2.grader = v("f-grader") || null; row2.grade = v("f-grade").trim() || null; }
      var b = numVal("f-buy"); row2.buy_price = b;
      var mv = numVal("f-value"); row2.manual_value = mv;
      saveItem(row2, save);
    });
    body.appendChild(save);
    var first = document.getElementById("f-name"); if (first) first.focus();
  }

  function openEdit(it) {
    if ((it.kind || "carte") !== "carte") { openAddManual(it.kind, it); return; }
    var body = modal("Modifier " + it.name);
    var row = el("div", "field-row");
    row.appendChild(field("f-buy", "Prix d'achat l'unité (€)", "number", "0,00", it.buy_price));
    row.appendChild(field("f-qty", "Quantité", "number", "1", it.qty));
    body.appendChild(row);
    body.appendChild(field("f-value", "Valeur l'unité (€)", "number", "vide = cote automatique", it.manual_value));
    var save = el("button", "btn btn-accent", "Enregistrer");
    save.style.width = "100%";
    save.addEventListener("click", function () {
      saveItem({ id: it.id, kind: it.kind, card_id: it.card_id, name: it.name,
        set_id: it.set_id, set_name: it.set_name, local_id: it.local_id,
        condition: it.condition, status: it.status || "stock",
        qty: intVal("f-qty", it.qty || 1), buy_price: numVal("f-buy"), manual_value: numVal("f-value") }, save);
    });
    body.appendChild(save);
  }

  function openSale(preselect) {
    var stock = state.items.filter(inStock);
    var body = modal("Enregistrer une vente");
    if (!stock.length) { body.appendChild(el("p", "hint", "Aucun article en stock à vendre.")); return; }
    body.appendChild(selectField("f-item", "Article vendu",
      stock.map(function (i) { return [i.id, i.name + " — " + KINDS[i.kind || "carte"] + " · " + i.qty + " en stock"]; }), preselect));
    var r1 = el("div", "field-row");
    r1.appendChild(field("f-date", "Date", "date", "", today()));
    r1.appendChild(field("f-qty", "Quantité vendue", "number", "1", "1"));
    body.appendChild(r1);
    var r2 = el("div", "field-row");
    r2.appendChild(field("f-gross", "Prix brut (€)", "number", "0,00"));
    r2.appendChild(field("f-fees", "Frais plateforme (€)", "number", "0,00"));
    body.appendChild(r2);
    body.appendChild(selectField("f-platform", "Plateforme", PLATFORMS.map(function (p) { return [p, p]; })));
    var save = el("button", "btn btn-accent", "Enregistrer la vente");
    save.style.width = "100%";
    save.addEventListener("click", function () {
      var item = state.items.filter(function (i) { return i.id === v("f-item"); })[0];
      if (!item) return;
      var qty = intVal("f-qty", 1) || 1;
      if (qty > item.qty) { save.parentNode.appendChild(el("p", "hint err", "Tu n'as que " + item.qty + " en stock.")); return; }
      var gross = numVal("f-gross");
      if (gross == null) { save.parentNode.appendChild(el("p", "hint err", "Indique le prix de vente brut.")); return; }
      save.disabled = true; save.textContent = "Enregistrement…";
      sb.from("sales").insert({
        id: "s-" + Date.now().toString(36), user_id: session.user.id,
        item_id: item.id, name: item.name, kind: item.kind || "carte",
        sold_on: v("f-date") || today(), qty: qty, gross: gross, fees: numVal("f-fees") || 0,
        platform: v("f-platform") || "Autre", buy_price: item.buy_price != null ? Number(item.buy_price) : 0
      }).then(function (res) {
        if (res.error) throw res.error;
        return sb.from("items").update({ qty: item.qty - qty }).eq("id", item.id).eq("user_id", session.user.id);
      }).then(function () { closeModal(); loadAll(); })
        .catch(function (err) {
          save.disabled = false; save.textContent = "Enregistrer la vente";
          save.parentNode.appendChild(el("p", "hint err", "Échec : " + (err.message || err)));
        });
    });
    body.appendChild(save);
  }

  function saveItem(row, button) {
    if (!sb || !session) return;
    row.user_id = session.user.id;
    button.disabled = true;
    var old = button.textContent; button.textContent = "Enregistrement…";
    sb.from("items").upsert(row, { onConflict: "user_id,id" }).then(function (res) {
      if (res.error) throw res.error;
      closeModal(); loadAll();
    }).catch(function (err) {
      button.disabled = false; button.textContent = old;
      button.parentNode.appendChild(el("p", "hint err", "Échec : " + (err.message || err)));
    });
  }
  function removeItem(it) {
    sb.from("items").delete().eq("id", it.id).eq("user_id", session.user.id)
      .then(function () { loadAll(); }).catch(function () {});
  }
  function removeSale(s) {
    sb.from("sales").delete().eq("id", s.id).eq("user_id", session.user.id)
      .then(function () { loadAll(); }).catch(function () {});
  }

  // ------------------------------------------------------------- démarrage

  function setView(x) {
    view = VIEWS.indexOf(x) >= 0 ? x : "dashboard";
    if (location.hash.slice(1) !== view) location.hash = view;
    render();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".rail-btn[data-view]"), function (b) {
    b.addEventListener("click", function () { setView(b.dataset.view); });
  });
  window.addEventListener("hashchange", function () { setView(location.hash.slice(1)); });
  view = VIEWS.indexOf(location.hash.slice(1)) >= 0 ? location.hash.slice(1) : "dashboard";

  initAuth();
})();
