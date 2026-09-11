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

// ---------- Import iCal (Kalisport) ----------

function unescapeICS(v) {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// Parse minimal d'un .ics : SUMMARY, DTSTART, LOCATION, UID par VEVENT.
function parseICS(text) {
  const unfolded = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const events = [];
  let cur = null;
  for (const line of unfolded.split("\n")) {
    if (line.startsWith("BEGIN:VEVENT")) cur = {};
    else if (line.startsWith("END:VEVENT")) {
      if (cur && cur.start) {
        if (!cur.summary) cur.summary = "Événement";
        events.push(cur);
      }
      cur = null;
    }
    else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).split(";")[0].toUpperCase();
      const value = line.slice(idx + 1);
      if (key === "SUMMARY") cur.summary = unescapeICS(value);
      else if (key === "LOCATION") cur.location = unescapeICS(value);
      else if (key === "UID") cur.uid = value.trim();
      else if (key === "DTSTART") cur.start = icsDate(value.trim());
      else if (key === "LAST-MODIFIED" || (key === "DTSTAMP" && !cur.modified)) cur.modified = icsEpoch(value.trim());
    }
  }
  return events;
}

// Tolère le format iCal standard (20260927T150000Z) et les variantes
// ISO avec séparateurs parfois générées côté serveur (2026-09-27T15:00:00).
const ICS_DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/;

function icsDate(v) {
  const m = v.match(ICS_DATE_RE);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, "0");
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: "" };
  const d = new Date(icsParsedEpoch(m));
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function icsParsedEpoch(m) {
  const args = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)];
  const tz = m[7];
  if (!tz) return new Date(...args).getTime();
  if (tz === "Z") return Date.UTC(...args);
  const sign = tz[0] === "-" ? -1 : 1;
  const [, oh, om] = tz.slice(1).replace(":", "").match(/(\d{2})(\d{2})/);
  return Date.UTC(...args) - sign * (+oh * 60 + +om) * 60000;
}

function icsEpoch(v) {
  const m = v.match(ICS_DATE_RE);
  return m && m[4] ? icsParsedEpoch(m) : 0;
}

// Id stable dérivé de l'UID iCal : réimporter ne crée pas de doublon.
function icsId(ev) {
  const s = ev.uid || ev.summary + ev.start.date;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "ics" + (h >>> 0).toString(36);
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

// Un match saisi à la main affiche "vs Adversaire" ; un match importé
// garde l'intitulé complet de l'événement Kalisport.
function matchTitle(m) {
  return m.imported ? m.opponent : "vs " + m.opponent;
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

  let html = `<div class="section-actions">
    <button class="btn-primary" id="new-match">+ Nouveau match</button>
    <button class="btn-secondary" id="import-ics">📥 Import Kalisport</button>
  </div>`;
  if (savedIcsUrl) {
    html += `<div class="section-actions">
      <button class="btn-secondary" id="refresh-ics">🔄 Actualiser depuis Kalisport</button>
    </div>`;
  }

  html += `<h2>À venir</h2>`;
  if (!upcoming.length) {
    html += `<p class="empty">Aucun match prévu.<br>Créez-en un ou ouvrez un lien partagé par l'équipe.</p>`;
  } else {
    html += upcoming.map((m) => matchCard(m)).join("");
  }

  if (past.length) {
    html += `<h2>Passés</h2>` + past.map((m) => matchCard(m, true)).join("");
  }

  app.innerHTML = html;
  document.getElementById("new-match").onclick = () => renderForm();
  document.getElementById("import-ics").onclick = () => renderImport();
  const refreshBtn = document.getElementById("refresh-ics");
  if (refreshBtn) refreshBtn.onclick = () => refreshFromKalisport();
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
    <p class="match-title">${esc(matchTitle(m))} ${badge}</p>
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

function icsHttpUrl(link) {
  return link.trim().replace(/^webcal:\/\//i, "https://");
}

let savedIcsUrl = "";
try { savedIcsUrl = localStorage.getItem(STORAGE_KEY + ":icsurl") || ""; } catch (e) {}

// Importe silencieusement les événements à venir (et ceux déjà connus,
// pour propager les changements d'horaire). Renvoie le nombre traité.
function mergeEvents(events) {
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const ev of events) {
    const id = icsId(ev);
    if (ev.start.date < today && !state.matches.some((m) => m.id === id)) continue;
    mergeMatch({
      id,
      opponent: ev.summary,
      date: ev.start.date,
      time: ev.start.time,
      type: "away",
      location: ev.location || "",
      imported: true,
      players: [],
      updatedAt: ev.modified || 0,
    });
    count++;
  }
  saveState();
  return count;
}

async function fetchIcs(link) {
  const res = await fetch(icsHttpUrl(link));
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

async function refreshFromKalisport() {
  toast("Actualisation…");
  try {
    const events = parseICS(await fetchIcs(savedIcsUrl));
    const count = mergeEvents(events);
    toast(`Calendrier à jour ✔ (${count} match${count > 1 ? "s" : ""})`);
    renderList();
  } catch (e) {
    toast("Impossible de joindre le calendrier — réessayez ou passez par le fichier .ics");
  }
}

function renderImport() {
  app.innerHTML = `
    <button class="btn-link" id="back">← Tous les matchs</button>
    <div class="card">
      <h2 style="margin-top:0">📥 Importer depuis Kalisport</h2>
      <p class="match-meta">Collez le lien d'export du calendrier Kalisport
      (webcal://… ou https://…). Si le serveur refuse la lecture directe,
      passez par le fichier .ics.</p>
      <label>Lien du calendrier</label>
      <input id="i-url" type="url" value="${esc(savedIcsUrl)}" placeholder="webcal://…">
      <div id="i-url-fallback"></div>
      <label>… ou fichier .ics</label>
      <input id="i-file" type="file" accept=".ics,text/calendar">
      <label>… ou contenu collé</label>
      <textarea id="i-text" rows="5" placeholder="BEGIN:VCALENDAR…"
        style="font: inherit; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px;"></textarea>
      <div class="section-actions">
        <button class="btn-primary" id="i-parse">Analyser</button>
      </div>
      <div id="i-results"></div>
    </div>`;

  document.getElementById("back").onclick = () => renderList();

  let events = [];
  const analyse = (text) => {
    events = parseICS(text);
    const results = document.getElementById("i-results");
    if (!events.length) {
      const vevents = (text.match(/BEGIN:VEVENT/g) || []).length;
      const diag = vevents
        ? `Le calendrier contient ${vevents} événement${vevents > 1 ? "s" : ""}, mais leur format de date n'a pas été reconnu.`
        : text.includes("BEGIN:VCALENDAR")
          ? "Le calendrier reçu est vide (aucun événement)."
          : "Le contenu reçu ne ressemble pas à un calendrier (.ics).";
      results.innerHTML = `<p class="empty">Aucun événement importable.<br>${diag}</p>
        <label>Début du contenu reçu (à transmettre pour diagnostic)</label>
        <pre style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
          padding: 10px; font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap;
          word-break: break-all;">${esc(text.slice(0, 400))}</pre>`;
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    results.innerHTML = `
      <label>Événements trouvés (${events.length}) — cochez ceux à importer</label>
      <ul class="player-list">${events
        .map((ev, i) => {
          const future = ev.start.date >= today;
          const known = state.matches.some((m) => m.id === icsId(ev));
          return `<li><label style="display:flex; gap:8px; align-items:center; font-weight:400; margin:0; width:100%;">
            <input type="checkbox" data-ev="${i}" style="width:auto" ${future && !known ? "checked" : ""}>
            <span style="flex:1">${esc(ev.summary)}<br>
              <span class="match-meta">${esc(formatDate(ev.start.date, ev.start.time))}${ev.location ? " · " + esc(ev.location) : ""}${known ? " · déjà importé" : ""}</span>
            </span>
          </label></li>`;
        })
        .join("")}</ul>
      <div class="section-actions">
        <button class="btn-primary" id="i-import">Importer la sélection</button>
      </div>`;

    document.getElementById("i-import").onclick = () => {
      const checked = [...results.querySelectorAll("input[data-ev]:checked")];
      if (!checked.length) return toast("Rien de sélectionné");
      for (const box of checked) {
        const ev = events[Number(box.dataset.ev)];
        mergeMatch({
          id: icsId(ev),
          opponent: ev.summary,
          date: ev.start.date,
          time: ev.start.time,
          type: "away",
          location: ev.location || "",
          imported: true,
          players: [],
          // L'horodatage Kalisport permet au ré-import de propager un changement
          // d'horaire, sans écraser une modification manuelle plus récente.
          updatedAt: ev.modified || 0,
        });
      }
      saveState();
      toast(`${checked.length} match${checked.length > 1 ? "s" : ""} importé${checked.length > 1 ? "s" : ""} ✔`);
      renderList();
    };
  };

  document.getElementById("i-parse").onclick = async () => {
    const url = document.getElementById("i-url").value.trim();
    const file = document.getElementById("i-file").files[0];
    const text = document.getElementById("i-text").value.trim();
    if (file) {
      const reader = new FileReader();
      reader.onload = () => analyse(reader.result);
      reader.readAsText(file);
    } else if (text) {
      analyse(text);
    } else if (url) {
      toast("Récupération du calendrier…");
      try {
        const content = await fetchIcs(url);
        savedIcsUrl = url;
        try { localStorage.setItem(STORAGE_KEY + ":icsurl", url); } catch (e) {}
        analyse(content);
      } catch (e) {
        // Lecture directe refusée (CORS) ou réseau : on guide vers le fichier.
        document.getElementById("i-url-fallback").innerHTML = `
          <p class="match-meta" style="color: var(--red); margin-top: 6px;">
          Le serveur du calendrier refuse la lecture directe depuis l'app.
          Pas grave : <a href="${esc(icsHttpUrl(url))}" download>téléchargez le fichier .ics</a>
          puis déposez-le ci-dessous.</p>`;
      }
    } else {
      toast("Collez un lien, choisissez un fichier ou collez le contenu");
    }
  };
}

// Mode conduite d'une réponse : "yes", "ifneeded" (on optimise sur le
// parking) ou "no". Les anciennes réponses stockaient un booléen.
function carMode(p) {
  if (p.car === true || p.car === "yes") return "yes";
  if (p.car === "ifneeded") return "ifneeded";
  return "no";
}

// État transitoire du formulaire de réponse
let myResponse = { status: null, car: "no", seats: 3, need: 1 };

function renderDetail(matchId) {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return renderList();

  const mine = m.players.find((p) => p.name.trim().toLowerCase() === myName.trim().toLowerCase());
  if (mine) myResponse = { status: mine.status, car: carMode(mine), seats: mine.seats ?? 3, need: mine.need ?? 1 };

  const present = m.players.filter((p) => p.status === "present");
  const drivers = present.filter((p) => carMode(p) === "yes");
  const flex = present.filter((p) => carMode(p) === "ifneeded");
  const seats = drivers.reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
  const flexSeats = flex.reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
  // Chaque conducteur (même « si besoin ») couvre sa propre famille ;
  // les autres indiquent combien de places il leur faut.
  const passengers = present
    .filter((p) => carMode(p) === "no")
    .reduce((sum, p) => sum + Math.max(1, Number(p.need) || 1), 0);
  const seatsOk = m.type === "home" || seats >= passengers;
  const flexOk = seats + flexSeats >= passengers;

  app.innerHTML = `
    <button class="btn-link" id="back">← Tous les matchs</button>
    <div class="card">
      <p class="match-title">${esc(matchTitle(m))}
        ${m.type === "home" ? '<span class="badge home">domicile</span>' : '<span class="badge away">extérieur</span>'}
      </p>
      <p class="match-meta">${esc(formatDate(m.date, m.time))}${m.location ? " · " + esc(m.location) : ""}</p>
    </div>

    <div class="summary">
      <div class="stat"><div class="num">${present.length}</div><div class="lbl">présents</div></div>
      <div class="stat"><div class="num">${drivers.length}${flex.length ? `+${flex.length}` : ""}</div><div class="lbl">voitures${flex.length ? " (+si besoin)" : ""}</div></div>
      ${m.type === "away"
        ? `<div class="stat ${seatsOk ? "ok" : flexOk ? "warn" : "ko"}"><div class="num">${seats}/${passengers}</div><div class="lbl">places libres / à transporter</div></div>`
        : ""}
    </div>
    ${m.type === "away" && flexSeats
      ? `<p class="match-meta" style="text-align:center; margin: -6px 0 12px;">＋ ${flexSeats} place${flexSeats > 1 ? "s" : ""} « si besoin » — on ajuste sur le parking 🅿️</p>`
      : ""}

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
          <button id="c-yes" class="${myResponse.car === "yes" ? "selected-yes" : ""}">🚗 Oui</button>
          <button id="c-flex" class="${myResponse.car === "ifneeded" ? "selected-flex" : ""}">Si besoin</button>
          <button id="c-no" class="${myResponse.car === "no" ? "selected-no" : ""}">Non</button>
        </div>
        <div id="seats-block" ${myResponse.car !== "no" ? "" : "hidden"}>
          <label>Places libres — sans compter votre enfant joueur</label>
          <p class="match-meta" style="margin: 0 0 6px;">Votre enfant a déjà sa place dans
          votre voiture : n'annoncez que les places restantes pour les autres.
          Ex : 5 sièges − vous − votre enfant = <strong>3 places libres</strong>.</p>
          <input id="r-seats" type="number" min="0" max="8" value="${myResponse.seats}">
        </div>
        <div id="need-block" ${myResponse.car === "no" ? "" : "hidden"}>
          <label>Combien de places vous faut-il ?</label>
          <p class="match-meta" style="margin: 0 0 6px;">Joueur + accompagnants sans voiture.
          Ex : votre enfant + vous qui venez aussi = <strong>2 places</strong>.</p>
          <input id="r-need" type="number" min="1" max="6" value="${myResponse.need}">
        </div>
      </div>
      <div class="section-actions">
        <button class="btn-primary" id="r-save">Envoyer ma réponse</button>
      </div>
    </div>

    <h2>Réponses (${m.players.length})</h2>
    ${m.players.length
      ? `<div class="card"><ul class="player-list">${m.players
          .map((p) => {
            const mode = carMode(p);
            const detail =
              p.status !== "present" ? "✘ absent"
              : mode === "yes" ? `✔ présent · 🚗 ${Number(p.seats) || 0} pl. libres`
              : mode === "ifneeded" ? `✔ présent · 🚗 si besoin (${Number(p.seats) || 0} pl.)`
              : (Number(p.need) || 1) > 1 ? `✔ présent · 🙋 ${p.need} places`
              : "✔ présent";
            return `<li><span>${esc(p.name)}</span><span class="player-status ${p.status}">${detail}</span></li>`;
          })
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
  for (const [id, mode] of [["c-yes", "yes"], ["c-flex", "ifneeded"], ["c-no", "no"]]) {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => { myResponse.car = mode; keepName(); rerender(); };
  }

  function keepName() {
    myName = document.getElementById("r-name").value;
    const seatsInput = document.getElementById("r-seats");
    if (seatsInput) myResponse.seats = Number(seatsInput.value) || 0;
    const needInput = document.getElementById("r-need");
    if (needInput) myResponse.need = Math.max(1, Number(needInput.value) || 1);
  }

  document.getElementById("r-save").onclick = () => {
    keepName();
    const name = myName.trim();
    if (!name) return toast("Indiquez votre nom");
    if (!myResponse.status) return toast("Présent ou absent ?");
    try { localStorage.setItem(STORAGE_KEY + ":name", name); } catch (e) {}
    const driving = myResponse.status === "present" && m.type === "away" ? myResponse.car : "no";
    const entry = {
      name,
      status: myResponse.status,
      car: driving,
      seats: driving !== "no" ? Number(myResponse.seats) || 0 : 0,
      need: driving === "no" ? Math.max(1, Number(myResponse.need) || 1) : 0,
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
    const text = `🚌 Sondage transport — ${matchTitle(m)} (${formatDate(m.date, m.time)})\nRéponds ici : ${url}`;
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
