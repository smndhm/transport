/* Transport — POC covoiturage matchs
 * Données en localStorage, partage par lien encodé (pas de backend). */

const STORAGE_KEY = "transport-app-v1";
const app = document.getElementById("app");

// ---------- État ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* stockage indisponible ou corrompu : on repart à vide */ }
  return { matches: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* mode privé : l'app fonctionne, sans persistance */ }
}

let state = loadState();
let myName = "";
try { myName = localStorage.getItem(STORAGE_KEY + ":name") || ""; } catch (e) {}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Partage par lien ----------

function encodeMatch(match) {
  const json = JSON.stringify(match);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

function decodeMatch(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function shareUrl(match) {
  const base = location.origin + location.pathname;
  return base + "#m=" + encodeMatch(match);
}

// Fusionne un match importé : les réponses les plus récentes gagnent.
function mergeMatch(incoming) {
  const existing = state.matches.find((m) => m.id === incoming.id);
  if (!existing) {
    state.matches.push(incoming);
    return incoming;
  }
  const byName = new Map();
  for (const p of existing.players) byName.set(p.name.trim().toLowerCase(), p);
  for (const p of incoming.players) {
    const key = p.name.trim().toLowerCase();
    const current = byName.get(key);
    if (!current || (p.updatedAt || 0) > (current.updatedAt || 0)) byName.set(key, p);
  }
  existing.players = [...byName.values()];
  // Les infos du match les plus récentes gagnent aussi.
  if ((incoming.updatedAt || 0) > (existing.updatedAt || 0)) {
    Object.assign(existing, { ...incoming, players: existing.players });
  }
  return existing;
}

function handleIncomingLink() {
  const hash = location.hash;
  if (!hash.startsWith("#m=")) return null;
  history.replaceState(null, "", location.pathname);
  try {
    const match = decodeMatch(hash.slice(3));
    if (!match || !match.id || !Array.isArray(match.players)) return null;
    const merged = mergeMatch(match);
    saveState();
    toast("Sondage importé ✔");
    return merged.id;
  } catch (e) {
    toast("Lien invalide");
    return null;
  }
}

// ---------- Helpers ----------

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function formatDate(dateStr, timeStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T" + (timeStr || "00:00"));
  const opts = { weekday: "long", day: "numeric", month: "long" };
  let out = d.toLocaleDateString("fr-FR", opts);
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (timeStr) out += " à " + timeStr.replace(":", "h");
  return out;
}

function isPast(match) {
  const d = new Date(match.date + "T" + (match.time || "23:59"));
  return d < new Date();
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ---------- Vues ----------

function renderList() {
  const matches = [...state.matches].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const upcoming = matches.filter((m) => !isPast(m));
  const past = matches.filter(isPast);

  let html = `<button class="btn-primary" id="new-match">+ Nouveau match</button>`;

  html += `<h2>À venir</h2>`;
  if (!upcoming.length) {
    html += `<p class="empty">Aucun match prévu.<br>Créez-en un ou ouvrez un lien partagé par l'équipe.</p>`;
  } else {
    html += upcoming.map(matchCard).join("");
  }

  if (past.length) {
    html += `<h2>Passés</h2>` + past.map((m) => matchCard(m, true)).join("");
  }

  app.innerHTML = html;
  document.getElementById("new-match").onclick = () => renderForm();
  app.querySelectorAll("[data-match]").forEach((el) => {
    el.onclick = () => renderDetail(el.dataset.match);
  });
}

function matchCard(m, past = false) {
  const present = m.players.filter((p) => p.status === "present").length;
  const badge = past
    ? `<span class="badge past">terminé</span>`
    : m.type === "home"
      ? `<span class="badge home">domicile</span>`
      : `<span class="badge away">extérieur</span>`;
  return `<div class="card clickable" data-match="${m.id}">
    <p class="match-title">vs ${esc(m.opponent)} ${badge}</p>
    <p class="match-meta">${esc(formatDate(m.date, m.time))} · ${present} présent${present > 1 ? "s" : ""}</p>
  </div>`;
}

function renderForm(match) {
  const m = match || { opponent: "", date: "", time: "", location: "", type: "away" };
  app.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">${match ? "Modifier le match" : "Nouveau match"}</h2>
      <label>Adversaire</label>
      <input id="f-opponent" value="${esc(m.opponent)}" placeholder="Ex : FC Trifouillis">
      <div class="row">
        <div><label>Date</label><input id="f-date" type="date" value="${esc(m.date)}"></div>
        <div><label>Heure</label><input id="f-time" type="time" value="${esc(m.time)}"></div>
      </div>
      <label>Domicile ou extérieur ?</label>
      <select id="f-type">
        <option value="away" ${m.type === "away" ? "selected" : ""}>Extérieur (déplacement)</option>
        <option value="home" ${m.type === "home" ? "selected" : ""}>Domicile</option>
      </select>
      <label>Lieu (optionnel)</label>
      <input id="f-location" value="${esc(m.location)}" placeholder="Ex : Gymnase Jean Moulin">
      <div class="section-actions">
        <button class="btn-secondary" id="f-cancel">Annuler</button>
        <button class="btn-primary" id="f-save">Enregistrer</button>
      </div>
    </div>`;

  document.getElementById("f-cancel").onclick = () => (match ? renderDetail(match.id) : renderList());
  document.getElementById("f-save").onclick = () => {
    const opponent = document.getElementById("f-opponent").value.trim();
    const date = document.getElementById("f-date").value;
    if (!opponent || !date) return toast("Adversaire et date obligatoires");
    const data = {
      opponent,
      date,
      time: document.getElementById("f-time").value,
      type: document.getElementById("f-type").value,
      location: document.getElementById("f-location").value.trim(),
      updatedAt: Date.now(),
    };
    if (match) {
      Object.assign(match, data);
      saveState();
      renderDetail(match.id);
    } else {
      const created = { id: uid(), players: [], ...data };
      state.matches.push(created);
      saveState();
      renderDetail(created.id);
    }
  };
}

// État transitoire du formulaire de réponse
let myResponse = { status: null, car: false, seats: 3 };

function renderDetail(matchId) {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return renderList();

  const mine = m.players.find((p) => p.name.trim().toLowerCase() === myName.trim().toLowerCase());
  if (mine) myResponse = { status: mine.status, car: !!mine.car, seats: mine.seats ?? 3 };

  const present = m.players.filter((p) => p.status === "present");
  const drivers = present.filter((p) => p.car);
  const seats = drivers.reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
  const passengers = present.length - drivers.length;
  const seatsOk = m.type === "home" || seats >= passengers;

  app.innerHTML = `
    <button class="btn-link" id="back">← Tous les matchs</button>
    <div class="card">
      <p class="match-title">vs ${esc(m.opponent)}
        ${m.type === "home" ? '<span class="badge home">domicile</span>' : '<span class="badge away">extérieur</span>'}
      </p>
      <p class="match-meta">${esc(formatDate(m.date, m.time))}${m.location ? " · " + esc(m.location) : ""}</p>
    </div>

    <div class="summary">
      <div class="stat"><div class="num">${present.length}</div><div class="lbl">présents</div></div>
      <div class="stat"><div class="num">${drivers.length}</div><div class="lbl">voitures</div></div>
      ${m.type === "away"
        ? `<div class="stat ${seatsOk ? "ok" : "ko"}"><div class="num">${seats}/${passengers}</div><div class="lbl">places / passagers</div></div>`
        : ""}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Ma réponse</h2>
      <label>Mon nom</label>
      <input id="r-name" value="${esc(myName)}" placeholder="Prénom">
      <label>Je viens ?</label>
      <div class="choice-group">
        <button id="r-yes" class="${myResponse.status === "present" ? "selected-yes" : ""}">✔ Présent</button>
        <button id="r-no" class="${myResponse.status === "absent" ? "selected-no" : ""}">✘ Absent</button>
      </div>
      <div id="car-block" ${myResponse.status === "present" && m.type === "away" ? "" : "hidden"}>
        <label>Je peux conduire ?</label>
        <div class="choice-group">
          <button id="c-yes" class="${myResponse.car ? "selected-yes" : ""}">🚗 Oui</button>
          <button id="c-no" class="${myResponse.car ? "" : "selected-no"}">Non</button>
        </div>
        <div id="seats-block" ${myResponse.car ? "" : "hidden"}>
          <label>Places passagers (en plus de moi)</label>
          <input id="r-seats" type="number" min="0" max="8" value="${myResponse.seats}">
        </div>
      </div>
      <div class="section-actions">
        <button class="btn-primary" id="r-save">Envoyer ma réponse</button>
      </div>
    </div>

    <h2>Réponses (${m.players.length})</h2>
    ${m.players.length
      ? `<div class="card"><ul class="player-list">${m.players
          .map(
            (p) => `<li><span>${esc(p.name)}</span><span class="player-status ${p.status}">
              ${p.status === "present" ? "✔ présent" + (p.car ? ` · 🚗 ${Number(p.seats) || 0} pl.` : "") : "✘ absent"}
            </span></li>`
          )
          .join("")}</ul></div>`
      : `<p class="empty">Personne n'a encore répondu.</p>`}

    <div class="section-actions">
      <button class="btn-primary" id="share">📤 Partager le sondage</button>
    </div>
    <div class="section-actions">
      <button class="btn-secondary" id="edit">Modifier le match</button>
      <button class="btn-danger" id="delete">Supprimer</button>
    </div>`;

  document.getElementById("back").onclick = () => renderList();
  document.getElementById("edit").onclick = () => renderForm(m);
  document.getElementById("delete").onclick = () => {
    if (confirm("Supprimer ce match ?")) {
      state.matches = state.matches.filter((x) => x.id !== m.id);
      saveState();
      renderList();
    }
  };

  const rerender = () => renderDetail(matchId);
  document.getElementById("r-yes").onclick = () => { myResponse.status = "present"; keepName(); rerender(); };
  document.getElementById("r-no").onclick = () => { myResponse.status = "absent"; keepName(); rerender(); };
  const cYes = document.getElementById("c-yes");
  const cNo = document.getElementById("c-no");
  if (cYes) cYes.onclick = () => { myResponse.car = true; keepName(); rerender(); };
  if (cNo) cNo.onclick = () => { myResponse.car = false; keepName(); rerender(); };

  function keepName() {
    myName = document.getElementById("r-name").value;
    const seatsInput = document.getElementById("r-seats");
    if (seatsInput) myResponse.seats = Number(seatsInput.value) || 0;
  }

  document.getElementById("r-save").onclick = () => {
    keepName();
    const name = myName.trim();
    if (!name) return toast("Indiquez votre nom");
    if (!myResponse.status) return toast("Présent ou absent ?");
    try { localStorage.setItem(STORAGE_KEY + ":name", name); } catch (e) {}
    const entry = {
      name,
      status: myResponse.status,
      car: myResponse.status === "present" && m.type === "away" ? myResponse.car : false,
      seats: myResponse.car ? Number(myResponse.seats) || 0 : 0,
      updatedAt: Date.now(),
    };
    const idx = m.players.findIndex((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (idx >= 0) m.players[idx] = entry;
    else m.players.push(entry);
    saveState();
    toast("Réponse enregistrée ✔");
    rerender();
  };

  document.getElementById("share").onclick = async () => {
    const url = shareUrl(m);
    const text = `🚌 Sondage transport — vs ${m.opponent} (${formatDate(m.date, m.time)})\nRéponds ici : ${url}`;
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { /* annulé */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Lien copié ! Collez-le dans WhatsApp 📋");
    } catch (e) {
      prompt("Copiez ce lien :", url);
    }
  };
}

// ---------- Démarrage ----------

document.getElementById("home-link").onclick = () => renderList();

const importedId = handleIncomingLink();
if (importedId) renderDetail(importedId);
else renderList();
