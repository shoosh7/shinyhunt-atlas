/* Shiny Living Dex Guide — app logic
   Reimplements the Google Sheet's BEST() / SECOND_BEST():
   walk the methods in the user's preferred order and return the first
   (and second) method whose pool contains this Pokémon, keeping the
   pool's own tag (E = evolve pre-evo, $ = soft reset, * = needs DLC). */

(function () {
  "use strict";

  const STORE_KEY = "shiny-living-dex-v2";
  const SPRITE_BASE = "https://pokejungle.net/sprites/shiny/";
  const GEN_RANGES = { 1:[1,151], 2:[152,251], 3:[252,386], 4:[387,493], 5:[494,649], 6:[650,721], 7:[722,809], 8:[810,905], 9:[906,1025] };
  const GEN_NAMES = { 1:"Kanto", 2:"Johto", 3:"Hoenn", 4:"Sinnoh", 5:"Unova", 6:"Kalos", 7:"Alola", 8:"Galar/Hisui", 9:"Paldea" };

  const METHODS = DEX_DATA.methods;          // [{id,name,game,console,odds,oddsNote,rank}]
  const MONS = DEX_DATA.mons;                // [{i,n,d,m:{mid:code},f?,c?,s?}]
  const PRESETS = DEX_DATA.presets;

  /* ---------- state ---------- */
  const defaultState = () => ({
    ranks: Object.fromEntries(METHODS.map(m => [m.id, m.rank])),
    enabled: Object.fromEntries(METHODS.map(m => [m.id, true])),
    caught: {},            // mon key (slug) -> true
    counters: {},          // mon key -> { n: encounters, o: odds denominator or null }
    preset: null,
  });

  let state = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && saved.ranks) {
      state = { ...defaultState(), ...saved,
        ranks: { ...defaultState().ranks, ...saved.ranks },
        enabled: { ...defaultState().enabled, ...saved.enabled },
        counters: saved.counters || {} };
    }
  } catch (e) { /* fresh start */ }

  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    if (typeof queueCloudPush === "function") { try { queueCloudPush(); } catch (e) {} }
  };

  /* ---------- BEST engine ---------- */
  function orderedMethods() {
    return METHODS.slice().sort((a, b) => state.ranks[a.id] - state.ranks[b.id]);
  }
  function bestTwo(mon) {
    const found = [];
    for (const m of orderedMethods()) {
      if (!state.enabled[m.id]) continue;
      const code = mon.m[m.id];
      if (code) {
        found.push({ method: m, code });
        if (found.length === 2) break;
      }
    }
    return found;
  }
  function allHunts(mon) {
    return orderedMethods()
      .filter(m => mon.m[m.id])
      .map(m => ({ method: m, code: mon.m[m.id], enabled: state.enabled[m.id] }));
  }

  /* ---------- code tag rendering ---------- */
  function parseCode(code) {
    let c = code, soft = false, evolve = false, dlc = false;
    if (c.startsWith("$")) { soft = true; c = c.slice(1); }
    if (c.startsWith("E") && c !== "E") { evolve = true; c = c.slice(1); }
    if (c.endsWith("*")) { dlc = true; c = c.slice(0, -1); }
    return { base: c, soft, evolve, dlc };
  }
  function codeLabel(code) {
    const p = parseCode(code);
    let label = p.base;
    if (p.evolve) label = "E·" + label;
    if (p.soft) label = "$·" + label;
    if (p.dlc) label += "·✦DLC";
    return label;
  }
  function codeHint(code) {
    const p = parseCode(code);
    const bits = [];
    if (p.soft) bits.push("soft-reset encounter");
    if (p.evolve) bits.push("hunt the pre-evolution, then evolve");
    if (p.dlc) bits.push("requires the DLC");
    return bits.join(" · ");
  }

  /* ---------- search normalization ---------- */
  function normName(s) {
    return s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/♀/g, " f").replace(/♂/g, " m")
      .replace(/[’'.\-]/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  MONS.forEach(mon => {
    mon._search = normName(mon.n + " " + (mon.f || ""));
    mon._gen = null;
    if (mon.d != null) {
      for (const g of Object.keys(GEN_RANGES)) {
        const [lo, hi] = GEN_RANGES[g];
        if (mon.d >= lo && mon.d <= hi) { mon._gen = g; break; }
      }
    }
  });

  /* ---------- DOM refs ---------- */
  const $ = id => document.getElementById(id);
  const grid = $("grid"), genAccordion = $("genAccordion"), emptyState = $("emptyState"), resultMeta = $("resultMeta");
  const openGens = new Set();  // which generation accordions the user has expanded
  const searchInput = $("searchInput"), genFilter = $("genFilter"),
        caughtFilter = $("caughtFilter"), huntableFilter = $("huntableFilter"),
        methodFilter = $("methodFilter"), sortSelect = $("sortSelect"), bulkToggle = $("bulkToggle");
  let bulkMode = false;
  const methodList = $("methodList"), methodsTable = $("methodsTable");
  const progressCount = $("progressCount"), progressFill = $("progressFill");
  const modalScrim = $("modalScrim"), modalBody = $("modalBody");
  const rail = $("rail"), drawerScrim = $("drawerScrim");

  /* ---------- progress ---------- */
  function renderProgress() {
    const total = MONS.length;
    const got = Object.keys(state.caught).filter(k => state.caught[k]).length;
    progressCount.textContent = `${got} / ${total}`;
    progressFill.style.width = (100 * got / total).toFixed(2) + "%";
  }

  /* ---------- settings rail ---------- */
  function renderRail() {
    const ms = orderedMethods();
    methodList.innerHTML = "";
    ms.forEach((m, idx) => {
      const li = document.createElement("li");
      li.className = "method-item" + (state.enabled[m.id] ? "" : " is-off");
      li.innerHTML = `
        <span class="method-rank">${idx + 1}</span>
        <span class="method-label">
          <span class="m-name">${m.name}</span>
          <span class="m-console">${m.console}</span>
        </span>
        <span class="method-ctrls">
          <button class="mini-btn" data-up="${m.id}" aria-label="Move ${m.name} up" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="mini-btn" data-down="${m.id}" aria-label="Move ${m.name} down" ${idx === ms.length - 1 ? "disabled" : ""}>▼</button>
          <input class="m-toggle" type="checkbox" data-toggle="${m.id}" ${state.enabled[m.id] ? "checked" : ""} aria-label="Enable ${m.name}">
        </span>`;
      methodList.appendChild(li);
    });
    document.querySelectorAll(".preset-btn").forEach(b =>
      b.classList.toggle("is-active", b.dataset.preset === state.preset));
  }

  function moveMethod(id, dir) {
    const ms = orderedMethods();
    const idx = ms.findIndex(m => m.id === id);
    const swap = ms[idx + dir];
    if (!swap) return;
    ms[idx + dir] = ms[idx]; ms[idx] = swap;
    ms.forEach((m, i) => { state.ranks[m.id] = i + 1; });
    state.preset = null;
    save(); renderRail(); renderGrid(); renderMethodsTable();
  }

  methodList.addEventListener("click", e => {
    const up = e.target.closest("[data-up]"), down = e.target.closest("[data-down]");
    if (up) moveMethod(up.dataset.up, -1);
    if (down) moveMethod(down.dataset.down, +1);
  });
  methodList.addEventListener("change", e => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    state.enabled[t.dataset.toggle] = t.checked;
    save(); renderRail(); renderGrid(); renderMethodsTable();
  });
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      state.ranks = { ...p };
      state.preset = btn.dataset.preset;
      save(); renderRail(); renderGrid(); renderMethodsTable();
    });
  });

  /* ---------- dex grid ---------- */
  function visibleMons() {
    const q = normName(searchInput.value || "");
    const gen = genFilter.value ? GEN_RANGES[genFilter.value] : null;
    const cf = caughtFilter.value;
    const mf = methodFilter.value;
    const huntableOnly = huntableFilter.checked;
    const qNum = /^#?\d{1,4}$/.test((searchInput.value || "").trim()) ? parseInt((searchInput.value).replace("#", ""), 10) : null;
    return MONS.filter(mon => {
      if (qNum != null) { if (mon.d !== qNum) return false; }
      else if (q && !mon._search.includes(q)) return false;
      if (gen && (mon.d == null || mon.d < gen[0] || mon.d > gen[1])) return false;
      if (cf === "caught" && !state.caught[mon.k]) return false;
      if (cf === "uncaught" && state.caught[mon.k]) return false;
      if (cf === "active" && !(state.counters[mon.k]?.n > 0 && !state.caught[mon.k])) return false;
      if (mf && !mon.m[mf]) return false;
      if (huntableOnly && bestTwo(mon).length === 0) return false;
      return true;
    }).sort(sorter());
  }

  function oddsScore(mon) {
    const picks = bestTwo(mon);
    if (!picks.length) return Infinity;
    if (picks[0].code.startsWith("$")) return 1365;  // soft-reset encounters run at boosted full odds at best
    return Math.min(...picks[0].method.oddsPresets.map(p => p[1]));
  }
  function sorter() {
    const mode = sortSelect.value;
    if (mode === "name") return (a, b) => a.n.localeCompare(b.n);
    if (mode === "odds") return (a, b) => oddsScore(a) - oddsScore(b) || a.i - b.i;
    return (a, b) => a.i - b.i;  // dex order (the guide's own order)
  }

  window.__spriteFallback = function (img) {
    const dex = img.dataset.dex;
    if (img.dataset.fb === "1" || !dex) { img.classList.add("is-missing"); return; }
    img.dataset.fb = "1";
    img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/${+dex}.png`;
  };
  function spriteImg(mon, cls) {
    if (!mon.s) return `<span class="${cls} is-missing"></span>`;
    // PokeAPI fallback is keyed by National Dex number, so it only fits base forms
    const canFallback = mon.d != null && /^\d{4}$/.test(mon.s);
    return `<img class="${cls}" src="${SPRITE_BASE}${mon.s}.png" alt="" loading="lazy"
      ${canFallback ? `data-dex="${mon.d}"` : ""} onerror="window.__spriteFallback(this)">`;
  }

  function badgeHTML(pick, tier) {
    const label = codeLabel(pick.code);
    const hint = codeHint(pick.code);
    const title = `${pick.method.name}${hint ? " — " + hint : ""}`;
    return `<span class="badge badge-${tier}" title="${title.replace(/"/g, "&quot;")}">${label}</span>`;
  }

  function cardHTML(mon) {
    const picks = bestTwo(mon);
    let badges;
    const mf = methodFilter.value;
    if (mf && mon.m[mf]) {
      const meth = METHODS.find(x => x.id === mf);
      const hint = codeHint(mon.m[mf]);
      badges = `<span class="badge badge-filtered" title="${(meth.name + (hint ? " — " + hint : "")).replace(/"/g, "&quot;")}">${codeLabel(mon.m[mf])}</span>`;
    } else if (picks.length === 0) {
      badges = `<span class="badge badge-none">no hunt in your games</span>`;
    } else {
      badges = badgeHTML(picks[0], "best") + (picks[1] ? badgeHTML(picks[1], "second") : "");
    }
    const cnt = state.counters[mon.k]?.n;
    const label = `${mon.n}${mon.f ? " (" + mon.f + ")" : ""} — open hunt details`;
    return `
      <article class="card${state.caught[mon.k] ? " is-caught" : ""}" tabindex="0" role="button"
        aria-label="${label.replace(/"/g, "&quot;")}" data-mon="${mon.i}" data-key="${mon.k}">
        <button class="catch-toggle" data-catch="${mon.k}" aria-label="Mark ${mon.n} as caught" aria-pressed="${!!state.caught[mon.k]}">✦</button>
        ${cnt > 0 && !state.caught[mon.k] ? `<span class="card-counter" title="Encounters so far in this hunt">✧ ${cnt.toLocaleString()}</span>` : ""}
        ${spriteImg(mon, "card-sprite")}
        <div class="card-dex">${mon.d != null ? "#" + String(mon.d).padStart(4, "0") : ""}</div>
        <div class="card-name">${mon.n}</div>
        ${mon.f ? `<div class="card-form">${mon.f}</div>` : ""}
        <div class="card-badges">${badges}</div>
      </article>`;
  }

  function hasActiveFilters() {
    return !!(searchInput.value.trim() || genFilter.value || caughtFilter.value || methodFilter.value || huntableFilter.checked);
  }

  function renderAccordion(mons) {
    const byGen = {};
    const other = [];
    mons.forEach(mon => (mon._gen ? (byGen[mon._gen] ||= []) : other).push(mon));
    const groups = Object.keys(GEN_RANGES)
      .map(g => ({ id: "gen-" + g, label: `Gen ${g} · ${GEN_NAMES[g]}`, mons: byGen[g] || [] }))
      .concat(other.length ? [{ id: "other", label: "Other / special forms", mons: other }] : [])
      .filter(g => g.mons.length);
    genAccordion.innerHTML = groups.map(g => `
      <details class="gen-group" data-gen-id="${g.id}"${openGens.has(g.id) ? " open" : ""}>
        <summary class="gen-summary">
          <span class="gen-name">${g.label}</span>
          <span class="gen-count">${g.mons.filter(m => state.caught[m.k]).length} / ${g.mons.length}</span>
        </summary>
        <div class="grid gen-grid">${g.mons.map(cardHTML).join("")}</div>
      </details>`).join("");
  }
  genAccordion.addEventListener("toggle", e => {
    const d = e.target;
    if (!d.classList || !d.classList.contains("gen-group")) return;
    if (d.open) openGens.add(d.dataset.genId); else openGens.delete(d.dataset.genId);
  }, true);

  let renderQueued = null;
  function renderGrid() {
    if (hasActiveFilters()) {
      const mons = visibleMons();
      resultMeta.textContent = `${mons.length} Pokémon`;
      emptyState.hidden = mons.length !== 0;
      grid.hidden = false;
      genAccordion.hidden = true;
      grid.innerHTML = mons.map(cardHTML).join("");
    } else {
      const mons = MONS.slice().sort(sorter());
      resultMeta.textContent = `${mons.length} Pokémon`;
      emptyState.hidden = true;
      grid.hidden = true;
      genAccordion.hidden = false;
      renderAccordion(mons);
    }
  }
  function queueRender() {
    clearTimeout(renderQueued);
    renderQueued = setTimeout(renderGrid, 120);
  }

  [searchInput].forEach(el => el.addEventListener("input", queueRender));
  [genFilter, caughtFilter, huntableFilter, methodFilter].forEach(el => el.addEventListener("change", renderGrid));

  const dexResults = $("main");
  dexResults.addEventListener("click", e => {
    const catchBtn = e.target.closest("[data-catch]");
    if (catchBtn) {
      e.stopPropagation();
      toggleCaught(catchBtn.dataset.catch, catchBtn);
      return;
    }
    const card = e.target.closest(".card");
    if (!card) return;
    if (bulkMode) toggleCaught(card.dataset.key, card.querySelector(".catch-toggle"));
    else openModal(+card.dataset.mon);
  });
  dexResults.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
      e.preventDefault();
      if (bulkMode) toggleCaught(e.target.dataset.key, e.target.querySelector(".catch-toggle"));
      else openModal(+e.target.dataset.mon);
    }
  });

  function toggleCaught(key, burstEl) {
    if (state.caught[key]) delete state.caught[key];
    else {
      state.caught[key] = new Date().toISOString().slice(0, 10);
      if (burstEl) celebrate(burstEl);
    }
    save(); renderProgress(); renderGenCounts();
    if (document.getElementById("view-hunts").classList.contains("is-active")) renderHunts();
    const card = dexResults.querySelector(`.card[data-key="${key}"]`);
    if (card) {
      card.classList.toggle("is-caught", !!state.caught[key]);
      const t = card.querySelector(".catch-toggle");
      t.setAttribute("aria-pressed", String(!!state.caught[key]));
      if (state.caught[key]) { t.classList.remove("just-caught"); void t.offsetWidth; t.classList.add("just-caught"); }
      const group = card.closest(".gen-group");
      if (group) {
        const countEl = group.querySelector(".gen-count");
        const total = group.querySelectorAll(".card").length;
        const caught = group.querySelectorAll(".card.is-caught").length;
        countEl.textContent = `${caught} / ${total}`;
      }
    }
    if (caughtFilter.value) renderGrid();
  }

  /* ---------- modal ---------- */
  let lastFocus = null;
  let modalKey = null;
  function openModal(i) {
    const mon = MONS[i];
    if (!mon) return;
    lastFocus = document.activeElement;
    const hunts = allHunts(mon);
    const picks = bestTwo(mon);
    const topId = picks[0] ? picks[0].method.id : null;

    let rows;
    if (hunts.length === 0) {
      rows = `<p class="hunt-none">No repeatable hunt is recorded for this one${mon.c ? " — see the note below" : ""}. It may be trade/transfer-only, event-locked, or shiny-locked.</p>`;
    } else {
      rows = hunts.map((h, idx) => {
        const p = parseCode(h.code);
        const isTop = h.method.id === topId && h.enabled;
        const flags = [];
        if (p.soft) flags.push("<strong>Soft reset:</strong> this is a static or gift encounter in this game — save in front of it and reset until it shines");
        if (p.evolve) flags.push("<strong>Evolve route:</strong> this method can't find it directly — hunt its pre-evolution, then evolve it");
        if (p.dlc) flags.push("<strong>Needs DLC:</strong> requires this game's expansion content");
        return `
        <div class="hunt-row ${isTop ? "is-top" : ""} ${h.enabled ? "" : "is-off"}">
          <span class="badge ${isTop ? "badge-best" : "badge-second"}">${isTop ? "✦ best" : "#" + (idx + 1)}</span>
          <span>
            <span class="h-name">${h.method.name}</span>
            <span class="h-game">${h.method.game} · ${h.method.console}${h.enabled ? "" : " · turned off in your setup"}</span>
            ${isTop ? `<span class="h-desc">${h.method.desc}</span>` : ""}
            <span class="h-odds"><em>Without Shiny Charm:</em> ${h.method.oddsBase}</span>
            <span class="h-odds"><em>With Shiny Charm:</em> ${h.method.oddsCharm}</span>
            ${flags.map(f => `<span class="h-flag">↳ ${f}</span>`).join("")}
          </span>
        </div>`;
      }).join("");
    }

    modalBody.innerHTML = `
      <div class="modal-hero">
        ${spriteImg(mon, "modal-sprite")}
        <div>
          <div class="modal-dex">${mon.d != null ? "#" + String(mon.d).padStart(4, "0") : ""}</div>
          <h2 id="modalName">${mon.n}</h2>
          ${mon.f ? `<div class="card-form">${mon.f}</div>` : ""}
          <br>
          <button class="modal-catch ${state.caught[mon.k] ? "is-caught" : ""}" data-modal-catch="${mon.k}" aria-pressed="${!!state.caught[mon.k]}">
            ✦ ${state.caught[mon.k] ? "Caught — in your living dex" : "Mark as caught"}
          </button>
          ${typeof state.caught[mon.k] === "string" ? `<span class="caught-date">since ${new Date(state.caught[mon.k] + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>` : ""}
        </div>
      </div>
      <h3 class="modal-section-title">Where to hunt it, in your order</h3>
      ${rows}
      <h3 class="modal-section-title">Hunt counter</h3>
      <div class="counter" data-counter-for="${mon.k}">
        <div class="counter-top">
          <span class="counter-n" id="cntN">${(state.counters[mon.k]?.n || 0).toLocaleString()}</span>
          <span class="counter-label">encounters<br>this hunt</span>
          <span class="counter-ctrls">
            <button class="cnt-btn" data-cnt="-1" aria-label="Remove one encounter">−1</button>
            <button class="cnt-btn cnt-main" data-cnt="1" aria-label="Add one encounter">+1</button>
            <button class="cnt-btn" data-cnt="10" aria-label="Add ten encounters">+10</button>
          </span>
        </div>
        <div class="counter-odds">
          <select id="cntPreset" aria-label="Fill in the odds for a hunt">
            <option value="">Fill odds from a hunt…</option>
            ${orderedMethods().filter(m => mon.m[m.id]).map(m =>
              `<optgroup label="${m.short}">` +
              m.oddsPresets.map(([label, o]) => `<option value="${o}">${label} — 1/${o.toLocaleString()}</option>`).join("") +
              `</optgroup>`).join("")}
            <optgroup label="General">
              <option value="4096">Full odds — 1/4,096</option>
              <option value="1365">Full odds + Charm — 1/1,365</option>
              <option value="8192">Old full odds (Gen 2–5) — 1/8,192</option>
            </optgroup>
          </select>
          <label>or type it:&nbsp; 1 /
            <input type="number" id="cntOdds" min="2" max="99999" inputmode="numeric"
              placeholder="512" value="${state.counters[mon.k]?.o || ""}">
          </label>
          <span class="counter-chance" id="cntChance"></span>
        </div>
        <button class="counter-reset" id="cntReset">Reset this counter</button>
        <span class="counter-tip">Tip: while this is open, ↑ / + counts an encounter and ↓ / − removes one.</span>
      </div>
      ${mon.c ? `<h3 class="modal-section-title">Note</h3><div class="modal-comments">${mon.c}</div>` : ""}`;
    modalScrim.hidden = false;
    document.body.style.overflow = "hidden";
    modalKey = mon.k;
    try { history.replaceState(null, "", "#" + mon.k); } catch (e) {}
    updateChanceLine(mon.k);
    $("modalClose").focus();
  }

  function updateChanceLine(key) {
    const el = $("cntChance");
    if (!el) return;
    const c = state.counters[key] || {};
    const n = c.n || 0, o = c.o;
    if (!o || o < 2) { el.textContent = "Set your method's odds to see your cumulative chance."; return; }
    if (!n) { el.textContent = `Every encounter is a 1 in ${o.toLocaleString()} chance. Good luck!`; return; }
    const chance = 100 * (1 - Math.pow(1 - 1 / o, n));
    el.textContent = `${chance.toFixed(1)}% of hunts at these odds find a shiny within ${n.toLocaleString()} encounters. The next one is still 1 in ${o.toLocaleString()} — hang in there.`;
  }

  function bumpCounter(key, delta) {
    const c = state.counters[key] || { n: 0, o: null };
    c.n = Math.max(0, (c.n || 0) + delta);
    state.counters[key] = c;
    if (!c.n && c.o == null) delete state.counters[key];
    save();
    const nEl = $("cntN");
    if (nEl) { nEl.textContent = (state.counters[key]?.n || 0).toLocaleString(); nEl.classList.remove("tick"); void nEl.offsetWidth; nEl.classList.add("tick"); }
    updateChanceLine(key);
    // refresh the card chip without a full grid re-render
    const card = dexResults.querySelector(`.card[data-key="${key}"]`);
    if (card) {
      let chip = card.querySelector(".card-counter");
      const n = state.counters[key]?.n || 0;
      if (n > 0 && !state.caught[key]) {
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "card-counter";
          chip.title = "Encounters so far in this hunt";
          card.appendChild(chip);
        }
        chip.textContent = `✧ ${n.toLocaleString()}`;
      } else if (chip) chip.remove();
    }
  }
  function closeModal() {
    modalScrim.hidden = true;
    document.body.style.overflow = "";
    modalKey = null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    if (lastFocus) lastFocus.focus();
  }

  // Keyboard counting: ↑/+ adds an encounter, ↓/− removes one, while a Pokémon is open
  document.addEventListener("keydown", e => {
    if (!modalKey || modalScrim.hidden) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowUp" || e.key === "+" || e.key === "=") { e.preventDefault(); bumpCounter(modalKey, 1); }
    else if (e.key === "ArrowDown" || e.key === "-") { e.preventDefault(); bumpCounter(modalKey, -1); }
  });
  modalBody.addEventListener("change", e => {
    if (e.target.id === "cntPreset") {
      const v = parseInt(e.target.value, 10);
      if (v) { $("cntOdds").value = v; $("cntOdds").dispatchEvent(new Event("change", { bubbles: true })); }
      e.target.value = "";
      return;
    }
    if (e.target.id !== "cntOdds") return;
    const key = e.target.closest("[data-counter-for]").dataset.counterFor;
    const v = parseInt(e.target.value, 10);
    const c = state.counters[key] || { n: 0, o: null };
    c.o = (v && v >= 2) ? v : null;
    state.counters[key] = c;
    if (!c.n && c.o == null) delete state.counters[key];
    save();
    updateChanceLine(key);
  });
  $("modalClose").addEventListener("click", closeModal);
  modalScrim.addEventListener("click", e => { if (e.target === modalScrim) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modalScrim.hidden) closeModal(); });
  modalBody.addEventListener("click", e => {
    const cnt = e.target.closest("[data-cnt]");
    if (cnt) {
      const key = e.target.closest("[data-counter-for]").dataset.counterFor;
      bumpCounter(key, +cnt.dataset.cnt);
      return;
    }
    if (e.target.id === "cntReset") {
      const key = e.target.closest("[data-counter-for]").dataset.counterFor;
      const n = state.counters[key]?.n || 0;
      if (!n || confirm(`Reset this hunt counter? (currently ${n.toLocaleString()} encounters)`)) {
        delete state.counters[key];
        save();
        $("cntN").textContent = "0";
        $("cntOdds").value = "";
        updateChanceLine(key);
        bumpCounter(key, 0);
      }
      return;
    }
    const b = e.target.closest("[data-modal-catch]");
    if (!b) return;
    const key = b.dataset.modalCatch;
    toggleCaught(key, b);
    b.classList.toggle("is-caught", !!state.caught[key]);
    b.setAttribute("aria-pressed", String(!!state.caught[key]));
    b.innerHTML = `✦ ${state.caught[key] ? "Caught — in your living dex" : "Mark as caught"}`;
    const dateEl = modalBody.querySelector(".caught-date");
    if (dateEl && !state.caught[key]) dateEl.remove();
    else if (!dateEl && typeof state.caught[key] === "string")
      b.insertAdjacentHTML("afterend", `<span class="caught-date">since ${new Date(state.caught[key] + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>`);
  });

  /* ---------- methods view ---------- */
  function renderMethodsTable() {
    const ms = orderedMethods();
    methodsTable.innerHTML = ms.map((m, idx) => `
      <div class="mrow ${state.enabled[m.id] ? "" : "is-off"}">
        <span class="mrow-rank">${String(idx + 1).padStart(2, "0")}</span>
        <span>
          <span class="mrow-name">${m.name}</span>
          <span class="mrow-game">${m.game} · ${m.console}${state.enabled[m.id] ? "" : " · turned off"}</span>
          <span class="mrow-desc">${m.desc}</span>
        </span>
        <span class="mrow-odds">
          <span class="odds-line"><em>Without Shiny Charm</em>${m.oddsBase}</span>
          <span class="odds-line"><em>With Shiny Charm</em>${m.oddsCharm}</span>
          ${m.oddsNote ? `<span class="mrow-note">${m.oddsNote}</span>` : ""}
        </span>
      </div>`).join("");
  }

  /* ---------- view switching ---------- */
  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach(t => t.classList.toggle("is-active", t === tab));
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("is-active", v.id === "view-" + tab.dataset.view));
      if (tab.dataset.view === "hunts") renderHunts();
    });
  });
  $("brandLink").addEventListener("click", e => {
    e.preventDefault();
    document.querySelector('.view-tab[data-view="dex"]').click();
    window.scrollTo({ top: 0 });
  });

  /* ---------- drawer (mobile) ---------- */
  const drawerToggle = $("drawerToggle");
  function setDrawer(open) {
    rail.classList.toggle("is-open", open);
    drawerScrim.hidden = !open;
    drawerToggle.setAttribute("aria-expanded", String(open));
  }
  drawerToggle.addEventListener("click", () => setDrawer(!rail.classList.contains("is-open")));
  $("drawerClose").addEventListener("click", () => setDrawer(false));
  drawerScrim.addEventListener("click", () => setDrawer(false));







  /* ---------- bulk entry mode ---------- */
  bulkToggle.addEventListener("click", () => {
    bulkMode = !bulkMode;
    bulkToggle.classList.toggle("is-active", bulkMode);
    bulkToggle.setAttribute("aria-pressed", String(bulkMode));
    document.body.classList.toggle("bulk-mode", bulkMode);
    $("bulkHint").hidden = !bulkMode;
  });

  sortSelect.addEventListener("change", renderGrid);

  /* ---------- catch celebration ---------- */
  function celebrate(el) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const burst = document.createElement("div");
    burst.className = "spark-burst";
    burst.style.left = (r.left + r.width / 2) + "px";
    burst.style.top = (r.top + r.height / 2) + "px";
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span");
      const ang = (Math.PI * 2 * i) / 10 + Math.random() * 0.6;
      const dist = 34 + Math.random() * 30;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      s.style.animationDelay = (Math.random() * 0.08) + "s";
      s.textContent = i % 3 ? "✦" : "✧";
      burst.appendChild(s);
    }
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 900);
  }

  /* ---------- pick my next hunt (guided) ---------- */
  const VIBES = {
    any:      { methods: null },
    handsoff: { methods: ["za", "fs", "sos", "lg"] },
    retro3ds: { methods: ["fs", "h", "cf"] },
    beginner: { methods: METHODS.map(m => m.id).filter(id => !["dpr", "pr", "cf"].includes(id)) },
    obvious:  { methods: ["pla", "za", "lg"] },
  };
  const pickerScrim = $("pickerScrim");
  function openPicker() {
    pickerScrim.hidden = false;
    document.body.style.overflow = "hidden";
    $("pickerClose").focus();
  }
  function closePicker() { pickerScrim.hidden = true; document.body.style.overflow = ""; }
  $("pickerClose").addEventListener("click", closePicker);
  pickerScrim.addEventListener("click", e => { if (e.target === pickerScrim) closePicker(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !pickerScrim.hidden) closePicker(); });

  pickerScrim.addEventListener("click", e => {
    const btn = e.target.closest("[data-vibe]");
    if (!btn) return;
    const vibe = VIBES[btn.dataset.vibe];
    const allowed = vibe.methods ? new Set(vibe.methods) : null;
    const pool = MONS.filter(m => {
      if (state.caught[m.k]) return false;
      return orderedMethods().some(meth =>
        state.enabled[meth.id] && m.m[meth.id] && (!allowed || allowed.has(meth.id)));
    });
    if (!pool.length) {
      $("pickerMsg").textContent = "No uncaught Pokémon fits that kind of hunt with your current games — try another option, or turn more methods on in your setup.";
      return;
    }
    $("pickerMsg").textContent = "";
    closePicker();
    openModal(pool[Math.floor(Math.random() * pool.length)].i);
  });

  /* ---------- hunts dashboard ---------- */
  function chanceText(c) {
    const n = c.n || 0, o = c.o;
    if (!o) return n ? "Set odds on this hunt to see your cumulative chance." : "";
    if (!n) return `1 in ${o.toLocaleString()} per encounter.`;
    const chance = 100 * (1 - Math.pow(1 - 1 / o, n));
    return `${chance.toFixed(1)}% of hunts at 1/${o.toLocaleString()} find a shiny within ${n.toLocaleString()} encounters.`;
  }

  function renderHunts() {
    const list = $("huntsList"), empty = $("huntsEmpty"), stats = $("huntsStats");
    const active = MONS
      .filter(m => state.counters[m.k]?.n > 0 && !state.caught[m.k])
      .sort((a, b) => (state.counters[b.k].n || 0) - (state.counters[a.k].n || 0));
    empty.hidden = active.length !== 0;
    const totalEnc = active.reduce((a, m) => a + (state.counters[m.k].n || 0), 0);
    stats.textContent = active.length
      ? `${active.length} hunt${active.length === 1 ? "" : "s"} in progress · ${totalEnc.toLocaleString()} encounters logged`
      : "";
    list.innerHTML = active.map(m => {
      const c = state.counters[m.k];
      const picks = bestTwo(m);
      const meth = picks[0] ? picks[0].method.short : "no enabled method";
      return `
      <article class="hunt-card" data-key="${m.k}">
        ${spriteImg(m, "hunt-card-sprite")}
        <div class="hunt-card-info">
          <button class="hunt-card-name" data-open="${m.i}">${m.n}${m.f ? ` <span class="card-form">${m.f}</span>` : ""}</button>
          <span class="hunt-card-method">${meth}${c.o ? ` · 1/${c.o.toLocaleString()}` : ""}</span>
          <span class="hunt-card-chance">${chanceText(c)}</span>
        </div>
        <div class="hunt-card-ctrls">
          <span class="hunt-card-n">${(c.n || 0).toLocaleString()}</span>
          <button class="cnt-btn cnt-main" data-hunt-bump="${m.k}" aria-label="Add one encounter to ${m.n}">+1</button>
        </div>
      </article>`;
    }).join("");
  }

  $("huntsList").addEventListener("click", e => {
    const bump = e.target.closest("[data-hunt-bump]");
    if (bump) {
      const key = bump.dataset.huntBump;
      bumpCounter(key, 1);
      const card = e.target.closest(".hunt-card");
      const c = state.counters[key] || {};
      const nEl = card.querySelector(".hunt-card-n");
      nEl.textContent = (c.n || 0).toLocaleString();
      nEl.classList.remove("tick"); void nEl.offsetWidth; nEl.classList.add("tick");
      card.querySelector(".hunt-card-chance").textContent = chanceText(c);
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openModal(+open.dataset.open);
  });
  $("huntsPick").addEventListener("click", () => openPicker());

  /* ---------- per-generation progress in the gen filter ---------- */
  function renderGenCounts() {
    const caughtIn = (lo, hi) => MONS.reduce((a, m) => a + ((m.d != null && m.d >= lo && m.d <= hi && state.caught[m.k]) ? 1 : 0), 0);
    const totalIn = (lo, hi) => MONS.reduce((a, m) => a + ((m.d != null && m.d >= lo && m.d <= hi) ? 1 : 0), 0);
    const names = { 1:"Kanto", 2:"Johto", 3:"Hoenn", 4:"Sinnoh", 5:"Unova", 6:"Kalos", 7:"Alola", 8:"Galar/Hisui", 9:"Paldea" };
    for (const opt of genFilter.options) {
      if (!opt.value) {
        const got = Object.keys(state.caught).length;
        opt.textContent = `All generations · ${got}/${MONS.length}`;
      } else {
        const [lo, hi] = GEN_RANGES[opt.value];
        opt.textContent = `Gen ${opt.value} · ${names[opt.value]} · ${caughtIn(lo, hi)}/${totalIn(lo, hi)}`;
      }
    }
  }

  /* ---------- pick my next hunt ---------- */
  $("randomHunt").addEventListener("click", () => openPicker());

  /* ---------- export / import / share ---------- */
  $("exportBtn").addEventListener("click", () => {
    const payload = { app: "shiny-living-dex", version: 2, exported: new Date().toISOString(),
      caught: state.caught, counters: state.counters, ranks: state.ranks, enabled: state.enabled, preset: state.preset };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date().toISOString().slice(0, 10);
    a.download = `shiny-dex-backup-${d}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "shiny-living-dex" || !data.caught) throw new Error("not a dex backup");
      const before = Object.keys(state.caught).length;
      state.caught = { ...state.caught, ...data.caught };
      const ic = data.counters || {};
      for (const k of Object.keys(ic)) {
        const a = state.counters[k] || {}, b = ic[k] || {};
        state.counters[k] = { n: Math.max(a.n || 0, b.n || 0), o: a.o ?? b.o ?? null };
      }
      if (data.ranks) state.ranks = { ...state.ranks, ...data.ranks };
      if (data.enabled) state.enabled = { ...state.enabled, ...data.enabled };
      if ("preset" in data) state.preset = data.preset;
      save();
      renderRail(); renderMethodsTable(); renderProgress(); renderGenCounts(); renderGrid();
      const added = Object.keys(state.caught).length - before;
      alert(`Backup restored — caught lists merged (${added} new shin${added === 1 ? "y" : "ies"} added), counters kept at their highest counts, and your method setup was loaded.`);
    } catch (err) {
      alert("That file doesn't look like a dex backup from this site. Nothing was changed.");
    }
  });


  /* ---------- CSV export ---------- */
  $("csvBtn").addEventListener("click", () => {
    const esc = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = [["Dex", "Name", "Form", "Caught", "Caught date", "Encounters", "Odds (1/x)", "Best method", "Second method"]];
    for (const m of MONS) {
      const picks = bestTwo(m);
      const c = state.counters[m.k] || {};
      rows.push([
        m.d ?? "", m.n, m.f ?? "",
        state.caught[m.k] ? "yes" : "no",
        typeof state.caught[m.k] === "string" ? state.caught[m.k] : "",
        c.n ?? "", c.o ?? "",
        picks[0] ? `${picks[0].method.short} [${picks[0].code}]` : "",
        picks[1] ? `${picks[1].method.short} [${picks[1].code}]` : "",
      ]);
    }
    const blob = new Blob(["\ufeff" + rows.map(r => r.map(esc).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shiny-dex-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("shareBtn").addEventListener("click", async () => {
    try { await document.fonts.ready; } catch (e) {}
    const got = Object.keys(state.caught).length, total = MONS.length;
    const pct = total ? (100 * got / total) : 0;
    const cv = document.createElement("canvas");
    cv.width = 1200; cv.height = 630;
    const x = cv.getContext("2d");
    x.fillStyle = "#10121a"; x.fillRect(0, 0, 1200, 630);
    x.fillStyle = "#f3c94f"; x.font = "44px 'Space Grotesk', sans-serif";
    x.fillText("✦", 70, 106);
    x.fillStyle = "#e9eaf2"; x.font = "700 40px 'Space Grotesk', sans-serif";
    x.fillText("Shiny Living Dex", 122, 104);
    x.fillStyle = "#8d93aa"; x.font = "24px 'Karla', sans-serif";
    x.fillText("shoosh's shiny hunting guide", 124, 140);
    x.fillStyle = "#f3c94f"; x.font = "700 130px 'Space Grotesk', sans-serif";
    x.fillText(`${got} / ${total}`, 70, 320);
    x.fillStyle = "#e9eaf2"; x.font = "700 44px 'Space Grotesk', sans-serif";
    x.fillText(`${pct.toFixed(1)}% of the living dex is shiny`, 72, 388);
    // per-gen bars
    const names = { 1:"Kanto",2:"Johto",3:"Hoenn",4:"Sinnoh",5:"Unova",6:"Kalos",7:"Alola",8:"Galar/Hisui",9:"Paldea" };
    const bw = 104, gap = 14, x0 = 70, y0 = 470;
    for (let g = 1; g <= 9; g++) {
      const [lo, hi] = GEN_RANGES[g];
      let t = 0, c = 0;
      MONS.forEach(m => { if (m.d != null && m.d >= lo && m.d <= hi) { t++; if (state.caught[m.k]) c++; } });
      const bx = x0 + (g - 1) * (bw + gap);
      x.fillStyle = "#1e2231"; x.fillRect(bx, y0, bw, 14);
      x.fillStyle = "#f3c94f"; x.fillRect(bx, y0, t ? bw * c / t : 0, 14);
      x.fillStyle = "#8d93aa"; x.font = "17px 'IBM Plex Mono', monospace";
      x.fillText(names[g], bx, y0 + 42);
      x.fillText(`${c}/${t}`, bx, y0 + 66);
    }
    x.fillStyle = "#5a5f75"; x.font = "18px 'Karla', sans-serif";
    x.fillText(new Date().toLocaleDateString(), 70, 596);
    cv.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "my-shiny-dex-progress.png";
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  });

  /* ---------- accounts & cloud sync (Supabase, optional) ---------- */
  const cfg = window.SUPABASE_CONFIG || {};
  const cloud = (cfg.url && cfg.anonKey && window.supabase)
    ? window.supabase.createClient(cfg.url, cfg.anonKey)
    : null;

  const accountBtn = $("accountBtn"), accountLabel = $("accountLabel");
  const authScrim = $("authScrim"), authForm = $("authForm"), authMsg = $("authMsg");
  const syncDot = $("syncDot");
  let user = null;
  let pushTimer = null;
  let authMode = "signin";

  function setSync(status, title) {
    if (!syncDot) return;
    syncDot.dataset.status = status; // "off" | "saved" | "saving" | "error"
    syncDot.title = title || "";
  }

  function renderAccount() {
    if (!cloud) { accountBtn.hidden = true; syncDot.hidden = true; return; }
    accountBtn.hidden = false; syncDot.hidden = !user;
    accountLabel.textContent = user ? (user.email || "Account") : "Sign in";
    accountBtn.setAttribute("aria-label", user ? `Account: ${user.email}. Open account options` : "Sign in to sync your dex");
  }

  function queueCloudPush() {
    if (!cloud || !user) return;
    setSync("saving", "Saving to your account…");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushCloud, 1200);
  }

  async function pushCloud() {
    if (!cloud || !user) return;
    const payload = { ranks: state.ranks, enabled: state.enabled, caught: state.caught, counters: state.counters, preset: state.preset };
    const { error } = await cloud.from("dex_state").upsert(
      { user_id: user.id, state: payload, updated_at: new Date().toISOString() });
    if (error) { setSync("error", "Couldn't save to your account — changes are still saved in this browser. " + error.message); }
    else setSync("saved", "Synced to your account");
  }

  async function pullCloud() {
    const { data, error } = await cloud.from("dex_state").select("state").eq("user_id", user.id).maybeSingle();
    if (error) { setSync("error", "Couldn't load your account data: " + error.message); return; }
    if (data && data.state) {
      const remote = data.state;
      // Cloud settings win; caught lists are merged so nothing is ever lost.
      state.ranks = { ...state.ranks, ...(remote.ranks || {}) };
      state.enabled = { ...state.enabled, ...(remote.enabled || {}) };
      state.preset = remote.preset ?? state.preset;
      state.caught = { ...(remote.caught || {}), ...state.caught };
      const rc = remote.counters || {};
      for (const k of new Set([...Object.keys(rc), ...Object.keys(state.counters)])) {
        const a = state.counters[k] || {}, b = rc[k] || {};
        state.counters[k] = { n: Math.max(a.n || 0, b.n || 0), o: a.o ?? b.o ?? null };
        if (!state.counters[k].n && state.counters[k].o == null) delete state.counters[k];
      }
      save();
      renderRail(); renderMethodsTable(); renderProgress(); renderGrid();
    }
    await pushCloud();
  }

  function openAuth() {
    if (user) {
      if (confirm(`Signed in as ${user.email}.\n\nSign out? (Your dex stays saved in this browser and in your account.)`)) {
        cloud.auth.signOut();
      }
      return;
    }
    authMsg.textContent = "";
    authScrim.hidden = false;
    document.body.style.overflow = "hidden";
    $("authEmail").focus();
  }
  function closeAuth() { authScrim.hidden = true; document.body.style.overflow = ""; }

  if (cloud) {
    accountBtn.addEventListener("click", openAuth);
    $("authClose").addEventListener("click", closeAuth);
    authScrim.addEventListener("click", e => { if (e.target === authScrim) closeAuth(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !authScrim.hidden) closeAuth(); });

    document.querySelectorAll(".auth-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        authMode = tab.dataset.mode;
        document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("is-active", t === tab));
        $("authSubmit").textContent = authMode === "signin" ? "Sign in" : "Create account";
        authMsg.textContent = "";
      });
    });

    authForm.addEventListener("submit", async e => {
      e.preventDefault();
      const email = $("authEmail").value.trim();
      const password = $("authPassword").value;
      if (!email || password.length < 6) { authMsg.textContent = "Enter your email and a password of at least 6 characters."; return; }
      $("authSubmit").disabled = true;
      authMsg.textContent = authMode === "signin" ? "Signing in…" : "Creating your account…";
      try {
        if (authMode === "signin") {
          const { error } = await cloud.auth.signInWithPassword({ email, password });
          if (error) throw error;
          authMsg.textContent = "";
          closeAuth();
        } else {
          const { data, error } = await cloud.auth.signUp({ email, password });
          if (error) throw error;
          if (data.session) { closeAuth(); }
          else { authMsg.textContent = "Account created — check your email for a confirmation link, then come back and sign in."; }
        }
      } catch (err) {
        authMsg.textContent = err.message || "Something went wrong — try again.";
      } finally {
        $("authSubmit").disabled = false;
      }
    });

    cloud.auth.onAuthStateChange((_event, session) => {
      user = session ? session.user : null;
      renderAccount();
      if (user) { setSync("saving", "Loading your account…"); pullCloud(); }
      else setSync("off", "");
    });
  }
  renderAccount();

  /* ---------- boot ---------- */
  orderedMethods().forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    methodFilter.appendChild(opt);
  });
  renderRail();
  renderMethodsTable();
  renderProgress();
  renderGenCounts();
  renderGrid();

  // Deep link: yoursite/#gible opens that Pokémon directly
  const hash = decodeURIComponent((location.hash || "").slice(1)).toLowerCase();
  if (hash) {
    const target = MONS.find(m => m.k === hash);
    if (target) openModal(target.i);
  }
})();
