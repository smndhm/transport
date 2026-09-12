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

// Mode organisateur : activé par ?admin dans l'URL puis mémorisé sur
// l'appareil. ?admin=0 le désactive (pour revoir l'app en mode parent).
// Ce n'est pas une sécurité, juste un paramètre non communiqué.
const legacyAdmin = (() => {
  const p = new URLSearchParams(location.search).get("admin");
  const off = p === "0" || p === "off";
  try {
    if (p === null) return localStorage.getItem(STORAGE_KEY + ":admin") === "1";
    if (off) localStorage.removeItem(STORAGE_KEY + ":admin");
    else localStorage.setItem(STORAGE_KEY + ":admin", "1");
  } catch (e) { /* stockage indisponible : le paramètre vaut pour la session */ }
  return !off;
})();

// En mode base, le droit d'organisateur vient du rôle dans l'équipe ;
// en mode local, du paramètre ?admin.
let isAdmin = legacyAdmin;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Stockage : local (POC) ou base (Supabase) ----------
//
// Les écrans lisent toujours state.matches ; seule cette couche change
// selon le mode. Si la base est injoignable, on retombe sur le local
// plutôt que d'afficher une page morte.

const Store = {
  mode: "local",
  teams: [],
  team: null,
  unwatch: null,

  get token() {
    return this.team ? this.team.join_token : null;
  },

  rememberTeam(id) {
    try { localStorage.setItem(STORAGE_KEY + ":team", id || ""); } catch (e) {}
  },
  lastTeam() {
    try { return localStorage.getItem(STORAGE_KEY + ":team") || null; } catch (e) { return null; }
  },

  async boot() {
    if (!DB.enabled()) return;
    await DB.ready();
    this.mode = "db";
    await this.loadTeams();
  },

  async loadTeams() {
    this.teams = await DB.myTeams();
    const wanted = this.lastTeam();
    this.team = this.teams.find((t) => t.id === wanted) || this.teams[0] || null;
    if (this.team) this.rememberTeam(this.team.id);
    isAdmin = this.team ? this.team.role === "organizer" : false;
  },

  async selectTeam(id) {
    this.team = this.teams.find((t) => t.id === id) || null;
    isAdmin = this.team ? this.team.role === "organizer" : false;
    this.rememberTeam(this.team ? this.team.id : null);
    await this.reload();
  },

  // Recharge les matchs de l'équipe courante. Le cache local évite un
  // écran vide quand le réseau est mauvais au bord d'un terrain.
  async reload() {
    if (this.mode !== "db") return;
    if (!this.team) { state.matches = []; return; }
    try {
      state.matches = await DB.loadTeam(this.team.id, this.team.name);
      DB.cacheWrite(this.team.id, state.matches);
    } catch (e) {
      const cached = DB.cacheRead(this.team.id);
      state.matches = cached || [];
      toast(cached ? "Hors ligne — dernières données connues" : "Impossible de joindre la base");
    }
  },

  // Réagit aux changements des autres téléphones.
  watch(onChange) {
    if (this.mode !== "db" || !this.team) return;
    if (this.unwatch) this.unwatch();
    this.unwatch = DB.watch(this.team.id, onChange);
  },

  async saveMatch(match, data) {
    if (this.mode === "db") {
      const id = await DB.saveMatch(this.team.id, { ...(match || {}), ...data });
      await this.reload();
      return id;
    }
    if (match) {
      Object.assign(match, data);
      saveState();
      return match.id;
    }
    const created = { id: uid(), players: [], ...data };
    state.matches.push(created);
    saveState();
    return created.id;
  },

  async deleteMatch(m) {
    if (this.mode === "db") {
      await DB.deleteMatch(m.dbId);
      await this.reload();
      return;
    }
    state.matches = state.matches.filter((x) => x.id !== m.id);
    saveState();
  },

  async saveResponse(m, answer, pointId, editing) {
    if (this.mode === "db") {
      await DB.saveResponse(m.dbId, pointId, answer, editing ? editing.id : null);
      await this.reload();
      return;
    }
    // Mode local : la réponse est identifiée par le nom saisi.
    const entry = {
      name: answer.name,
      car: answer.car,
      seats: answer.car === "yes" ? Number(answer.seats) || 0 : 0,
      ifUnused: answer.car === "yes" ? answer.ifUnused || "come" : "",
      rdv: answer.rdv,
      updatedAt: Date.now(),
    };
    if (editing) {
      const target = m.players.indexOf(editing);
      if (target >= 0) m.players[target] = entry;
    } else {
      const idx = m.players.findIndex((x) => x.name.trim().toLowerCase() === entry.name.toLowerCase());
      if (idx >= 0) m.players[idx] = entry;
      else m.players.push(entry);
    }
    saveState();
  },

  async importEvents(events) {
    if (this.mode === "db") {
      const count = await DB.importMatches(this.team.id, events);
      await this.reload();
      return count;
    }
    return mergeEvents(events);
  },

  // Le lien partagé invite dans l'équipe ; le match n'est qu'un point
  // d'arrivée. En mode local, on continue d'encoder le match entier.
  shareUrl(m) {
    const base = location.origin + location.pathname;
    if (this.mode === "db" && this.token) {
      return base + "#t=" + encodeURIComponent(this.token) + (m ? "&m=" + m.id : "");
    }
    return shareUrl(m);
  },
};

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
  history.replaceState(null, "", location.pathname + location.search);
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

// Un match peut avoir plusieurs points de rdv (cas d'une entente).
// Les sondages d'avant cette version n'en portaient qu'un, à plat.
function matchRdvs(m) {
  if (Array.isArray(m.rdvs) && m.rdvs.length) return m.rdvs;
  const legacyToTake = m.toTake != null && m.toTake !== ""
    ? Number(m.toTake) || 0
    : (m.players || []).reduce((sum, p) => sum + (Number(p.riders) || 0), 0);
  if (m.rdv || m.rdvTime || legacyToTake) {
    return [{ place: m.rdv || "", time: m.rdvTime || "", toTake: legacyToTake }];
  }
  return [];
}

// Point de départ d'une réponse, ramené aux points existants.
function rdvIndexOf(p, count) {
  const i = Number(p.rdv) || 0;
  return i >= 0 && i < count ? i : 0;
}

function playersToTake(m) {
  return matchRdvs(m).reduce((sum, r) => sum + (Number(r.toTake) || 0), 0);
}

// Qui pourrait laisser sa voiture quand il y a des places en trop.
function spareHint(g) {
  const canStay = g.drivers.filter((p) => p.ifUnused === "stay");
  if (!canStay.length) return "tout le monde souhaite venir";
  return canStay.map((p) => p.name).join(", ") + (canStay.length > 1 ? " peuvent rester" : " peut rester");
}

// Une ligne de la liste des réponses. `spare` : places en trop au point
// de départ — l'intention du conducteur ne s'affiche que dans ce cas.
function responseLine(p, idx, spare) {
  const seats = Number(p.seats) || 0;
  const tag = carMode(p) !== "no" && spare
    ? p.ifUnused === "stay" ? ` <span class="tag-stay">peut rester</span>` : ` <span class="tag-come">vient quand même</span>`
    : "";
  const detail = carMode(p) !== "no"
    ? `🚗 ${seats} place${seats > 1 ? "s" : ""}${tag}`
    : "🙋 sans voiture";
  return `<li data-edit="${idx}" style="cursor:pointer"><span>${esc(p.name)}</span>` +
    `<span class="player-status present">${detail} <span class="match-meta">✏️</span></span></li>`;
}

function rdvLabel(r) {
  const time = r.time ? "départ " + r.time.replace(":", "h") : "";
  return [r.place, time].filter(Boolean).join(" — ") || "Point de rdv";
}

function isPast(match) {
  const d = new Date(match.date + "T" + (match.time || "23:59"));
  return d < new Date();
}

// Exécute une action distante en signalant l'échec plutôt qu'en le
// laissant passer silencieusement.
async function withBusy(fn, errorMsg) {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    const detail = e && e.message ? " — " + e.message : "";
    toast((errorMsg || "Erreur") + detail);
  }
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
  currentMatchId = null;
  const matches = [...state.matches].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const upcoming = matches.filter((m) => !isPast(m));
  const past = matches.filter(isPast);

  let html = teamHeader();
  if (isAdmin) {
    html += `<div class="section-actions">
      <button class="btn-primary" id="new-match">+ Nouveau match</button>
      <button class="btn-secondary" id="import-ics">📥 Import Kalisport</button>
    </div>`;
    if (savedIcsUrl) {
      html += `<div class="section-actions">
        <button class="btn-secondary" id="refresh-ics">🔄 Actualiser depuis Kalisport</button>
      </div>`;
    }
  }

  // Hiérarchie : catégorie → matchs (→ point de rdv dans le détail).
  const byCategory = (list) => {
    const groups = new Map();
    for (const m of list) {
      const key = m.category || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const renderGroups = (list, past = false) => {
    const groups = byCategory(list);
    if (groups.length === 1 && !groups[0][0]) return list.map((m) => matchCard(m, past)).join("");
    return groups
      .map(([cat, ms]) => `<h3 class="cat-title">${esc(cat || "Sans catégorie")}</h3>` + ms.map((m) => matchCard(m, past)).join(""))
      .join("");
  };

  html += `<h2>À venir</h2>`;
  if (!upcoming.length) {
    html += isAdmin
      ? `<p class="empty">Aucun match prévu.<br>Créez-en un ou importez le calendrier Kalisport.</p>`
      : `<p class="empty">Aucun match pour l'instant.<br>Ouvrez le lien d'un match partagé par l'organisateur : il s'ajoutera ici.</p>`;
  } else {
    html += renderGroups(upcoming);
  }

  if (past.length) {
    html += `<h2>Passés</h2>` + renderGroups(past, true);
  }

  app.innerHTML = html;
  bindTeamHeader();
  if (isAdmin) {
    document.getElementById("new-match").onclick = () => renderForm();
    document.getElementById("import-ics").onclick = () => renderImport();
    const refreshBtn = document.getElementById("refresh-ics");
    if (refreshBtn) refreshBtn.onclick = () => refreshFromKalisport();
  }
  app.querySelectorAll("[data-match]").forEach((el) => {
    el.onclick = () => renderDetail(el.dataset.match);
  });
}

// En mode base : l'équipe courante, le sélecteur s'il y en a plusieurs,
// et le lien d'invitation pour l'organisateur.
function teamHeader() {
  if (Store.mode !== "db") return "";
  if (!Store.team) {
    return legacyAdmin
      ? `<div class="card">
           <h2 style="margin-top:0">Première équipe</h2>
           <p class="match-meta">Créez une catégorie (U11, U13…) puis partagez son lien aux parents.</p>
           <label>Nom de la catégorie</label>
           <input id="t-name" placeholder="Ex : U13">
           <div class="section-actions"><button class="btn-primary" id="t-create">Créer l'équipe</button></div>
         </div>`
      : `<p class="empty">Aucune équipe.<br>Ouvrez le lien d'invitation envoyé par l'organisateur.</p>`;
  }
  const others = Store.teams.length > 1;
  return `<div class="card">
    <p class="match-title" style="margin:0">${esc(Store.team.name)}
      ${isAdmin ? '<span class="badge home">organisateur</span>' : ""}</p>
    ${others ? `<label>Équipe</label><select id="t-switch">${Store.teams
      .map((t) => `<option value="${esc(t.id)}" ${t.id === Store.team.id ? "selected" : ""}>${esc(t.name)}</option>`)
      .join("")}</select>` : ""}
    <div class="section-actions">
      ${isAdmin ? `<button class="btn-secondary" id="t-invite">🔗 Inviter les parents</button>` : ""}
      ${legacyAdmin ? `<button class="btn-link" id="t-new">+ Nouvelle équipe</button>` : ""}
    </div>
  </div>`;
}

function bindTeamHeader() {
  const create = document.getElementById("t-create");
  if (create) {
    create.onclick = () => {
      const name = document.getElementById("t-name").value.trim();
      if (!name) return toast("Donnez un nom à l'équipe");
      withBusy(async () => {
        await DB.createTeam(name);
        await Store.loadTeams();
        await Store.reload();
        renderList();
      }, "Création impossible");
    };
  }
  const sw = document.getElementById("t-switch");
  if (sw) sw.onchange = () => withBusy(async () => { await Store.selectTeam(sw.value); renderList(); }, "Changement impossible");

  const nw = document.getElementById("t-new");
  if (nw) nw.onclick = () => {
    const name = prompt("Nom de la nouvelle catégorie (ex : U15) :");
    if (!name || !name.trim()) return;
    withBusy(async () => {
      await DB.createTeam(name.trim());
      await Store.loadTeams();
      await Store.reload();
      renderList();
    }, "Création impossible");
  };

  const inv = document.getElementById("t-invite");
  if (inv) inv.onclick = async () => {
    const url = Store.shareUrl(null);
    const text = `🚌 Transport ${Store.team.name} — inscris-toi une fois, tu verras tous les déplacements :\n${url}`;
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { /* annulé */ } }
    try { await navigator.clipboard.writeText(text); toast("Lien d'invitation copié 📋"); }
    catch (e) { prompt("Copiez ce lien :", url); }
  };
}

function matchCard(m, past = false) {
  const accomp = m.players.filter((p) => p.status !== "absent");
  const cars = accomp.filter((p) => carMode(p) !== "no");
  const walkers = accomp.filter((p) => carMode(p) === "no");
  const seats = cars.reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
  const riders = playersToTake(m) + walkers.length;
  const badge = past ? `<span class="badge past">terminé</span>` : "";
  return `<div class="card clickable" data-match="${m.id}">
    <p class="match-title">${esc(matchTitle(m))} ${badge}</p>
    <p class="match-meta">${esc(formatDate(m.date, m.time))} · ${cars.length} voiture${cars.length > 1 ? "s" : ""} · ${seats}/${riders} pl.</p>
  </div>`;
}

function renderForm(match) {
  if (!isAdmin) return renderList();
  const m = match || { opponent: "", date: "", time: "", location: "", category: "", arrivalTime: "", rdvs: [], type: "away" };
  const cats = [...new Set(state.matches.map((x) => x.category).filter(Boolean))];
  // Points de rdv édités dans le formulaire (au moins une ligne vide).
  let rdvs = matchRdvs(m).map((r) => ({ ...r }));
  if (!rdvs.length) rdvs = [{ place: "", time: "", toTake: "" }];
  app.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">${match ? "Modifier le match" : "Nouveau match"}</h2>
      <label>Catégorie</label>
      <input id="f-category" value="${esc(m.category || "")}" placeholder="Ex : U13" list="f-cats">
      <datalist id="f-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <label>Adversaire</label>
      <input id="f-opponent" value="${esc(m.opponent)}" placeholder="Ex : FC Trifouillis">
      <div class="row">
        <div><label>Date</label><input id="f-date" type="date" value="${esc(m.date)}"></div>
        <div><label>Heure</label><input id="f-time" type="time" value="${esc(m.time)}"></div>
      </div>
      <label>Lieu (optionnel)</label>
      <input id="f-location" value="${esc(m.location)}" placeholder="Ex : Gymnase Jean Moulin">
      <label>Heure sur place</label>
      <p class="match-meta" style="margin: 0 0 6px;">Pour ceux qui s'y rendent par leurs propres moyens.</p>
      <input id="f-arrival" type="time" value="${esc(m.arrivalTime || "")}">
      <h2 style="font-size: 1rem;">Points de rdv</h2>
      <div id="f-rdvs"></div>
      <button class="btn-link" id="f-addrdv">+ Ajouter un point de rdv</button>
      <div class="section-actions">
        <button class="btn-secondary" id="f-cancel">Annuler</button>
        <button class="btn-primary" id="f-save">Enregistrer</button>
      </div>
    </div>`;

  // Les lignes de rdv sont redessinées à chaque ajout/suppression.
  function drawRdvs() {
    document.getElementById("f-rdvs").innerHTML = rdvs
      .map((r, i) => `<div class="rdv-row">
        <div class="row">
          <div style="flex:2"><label>Lieu</label><input data-rdv="${i}" data-f="place" value="${esc(r.place || "")}" placeholder="Ex : parking du gymnase"></div>
          <div><label>Départ</label><input data-rdv="${i}" data-f="time" type="time" value="${esc(r.time || "")}"></div>
        </div>
        <div class="row">
          <div><label>Joueurs à prendre</label><input data-rdv="${i}" data-f="toTake" type="number" min="0" max="30" value="${esc(r.toTake ?? "")}" placeholder="Ex : 8"></div>
          ${rdvs.length > 1 ? `<div style="flex:0 0 auto; display:flex; align-items:flex-end"><button class="btn-danger" data-delrdv="${i}">Retirer</button></div>` : ""}
        </div>
      </div>`)
      .join("");
    document.querySelectorAll("[data-rdv]").forEach((el) => {
      el.oninput = () => { rdvs[Number(el.dataset.rdv)][el.dataset.f] = el.value; };
    });
    document.querySelectorAll("[data-delrdv]").forEach((el) => {
      el.onclick = () => { rdvs.splice(Number(el.dataset.delrdv), 1); drawRdvs(); };
    });
  }
  drawRdvs();
  document.getElementById("f-addrdv").onclick = () => { rdvs.push({ place: "", time: "", toTake: "" }); drawRdvs(); };

  document.getElementById("f-cancel").onclick = () => (match ? renderDetail(match.id) : renderList());
  document.getElementById("f-save").onclick = () => {
    const opponent = document.getElementById("f-opponent").value.trim();
    const date = document.getElementById("f-date").value;
    if (!opponent || !date) return toast("Adversaire et date obligatoires");
    const data = {
      opponent,
      date,
      time: document.getElementById("f-time").value,
      type: "away",
      location: document.getElementById("f-location").value.trim(),
      category: document.getElementById("f-category").value.trim(),
      arrivalTime: document.getElementById("f-arrival").value,
      rdvs: rdvs
        .map((r) => ({ place: (r.place || "").trim(), time: r.time || "", toTake: Math.max(0, Number(r.toTake) || 0) }))
        .filter((r) => r.place || r.time || r.toTake),
      updatedAt: Date.now(),
    };
    withBusy(async () => {
      const id = await Store.saveMatch(match, data);
      renderDetail(id);
    }, "Enregistrement impossible");
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
  if (!isAdmin) return renderList();
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
      const picked = checked.map((box) => events[Number(box.dataset.ev)]);
      withBusy(async () => {
        const n = await Store.importEvents(picked);
        toast(`${n} match${n > 1 ? "s" : ""} importé${n > 1 ? "s" : ""} ✔`);
        renderList();
      }, "Import impossible");
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

// État transitoire du formulaire de réponse.
// Une réponse par accompagnateur : nom, je conduis, places ou joueurs au rdv.
let myResponse = { car: null, seats: 3, rdv: 0, ifUnused: "come" };

// Les infos voiture sont mémorisées d'une réponse sur l'autre.
function loadCarPref() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY + ":car")) || null; } catch (e) { return null; }
}
function saveCarPref(pref) {
  try { localStorage.setItem(STORAGE_KEY + ":car", JSON.stringify(pref)); } catch (e) {}
}

function renderDetail(matchId, editIndex) {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return renderList();
  currentMatchId = matchId;

  // Les réponses des anciens formats restent lisibles : conduire était un
  // booléen ou « si besoin », et « ne vient pas » n'existe plus.
  const accomp = m.players.filter((p) => p.status !== "absent");
  const mineIdx = accomp.findIndex((p) => p.name.trim().toLowerCase() === myName.trim().toLowerCase());
  const editing = editIndex != null ? accomp[editIndex] : mineIdx >= 0 ? accomp[mineIdx] : null;
  // Le formulaire ne s'affiche que tant qu'on n'a pas répondu, ou pour éditer.
  const showForm = editIndex != null || mineIdx < 0;
  const editingOther = editIndex != null && editIndex !== mineIdx;

  if (editing) {
    myResponse = { car: carMode(editing) === "no" ? "no" : "yes", seats: editing.seats ?? 3, rdv: Number(editing.rdv) || 0, ifUnused: editing.ifUnused || "come" };
  } else {
    const pref = loadCarPref();
    if (pref) myResponse = { car: pref.car ?? null, seats: pref.seats ?? 3, rdv: 0, ifUnused: pref.ifUnused || "come" };
  }
  const formName = editingOther ? editing.name : myName;

  const drivers = accomp.filter((p) => carMode(p) !== "no");
  const walkers = accomp.filter((p) => carMode(p) === "no");
  const seats = drivers.reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
  // Joueurs annoncés par l'organisateur : c'est eux qui décident du feu vert.
  const riders = playersToTake(m);
  // Un accompagnateur sans voiture est lui aussi à prendre.
  const toTake = riders + walkers.length;
  const playersOk = seats >= riders;

  // Chaque réponse est rattachée à un point de rdv : le bilan se fait
  // aussi point par point, sinon des places d'un point compenseraient
  // à tort un manque dans l'autre.
  const rdvs = matchRdvs(m);
  const perRdv = rdvs.map((r, i) => {
    const members = accomp
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => rdvIndexOf(p, rdvs.length) === i);
    const at = members.map(({ p }) => p);
    const atSeats = at.filter((p) => carMode(p) !== "no").reduce((sum, p) => sum + (Number(p.seats) || 0), 0);
    const atDrivers = at.filter((p) => carMode(p) !== "no");
    const atWalkers = at.filter((p) => carMode(p) === "no").length;
    const atRiders = Number(r.toTake) || 0;
    const atToTake = atRiders + atWalkers;
    return { r, i, members, drivers: atDrivers, cars: at.length - atWalkers, seats: atSeats, riders: atRiders,
      toTake: atToTake, ok: atSeats >= atRiders, spare: Math.max(0, atSeats - atToTake) };
  });

  app.innerHTML = `
    <button class="btn-link" id="back">← Tous les matchs</button>
    <div class="card">
      <p class="match-title">${esc(matchTitle(m))}${m.category ? ` <span class="badge home">${esc(m.category)}</span>` : ""}</p>
      <p class="match-meta">${esc(formatDate(m.date, m.time))}${m.location ? " · " + esc(m.location) : ""}</p>
      ${m.arrivalTime ? `<p class="match-meta rdv">🏟️ Sur place à ${esc(m.arrivalTime.replace(":", "h"))}</p>` : ""}
    </div>

    <div class="summary">
      <div class="stat"><div class="num">${drivers.length}</div><div class="lbl">voitures</div></div>
      <div class="stat ${playersOk ? "ok" : "ko"}"><div class="num">${seats}/${toTake}</div><div class="lbl">places / à prendre</div></div>
    </div>
    ${playersOk && seats < toTake
      ? `<p class="match-meta" style="text-align:center; margin: -6px 0 12px;">Assez de places pour les joueurs ✔ — ${toTake - seats} accompagnateur${toTake - seats > 1 ? "s" : ""} sans voiture pas encore casé${toTake - seats > 1 ? "s" : ""}</p>`
      : ""}

    ${rdvs.length ? `<h2>Points de rdv</h2>` : ""}
    ${rdvs.length
      ? perRdv.map((g) => `<div class="card rdv-card">
          <p class="match-title" style="font-size:0.98rem">🅿️ ${esc(rdvLabel(g.r))}</p>
          <p class="match-meta">${g.riders} joueur${g.riders > 1 ? "s" : ""} à prendre · ${g.cars} voiture${g.cars > 1 ? "s" : ""}
            · <span class="${g.ok ? "seats-ok" : "seats-ko"}">${g.seats}/${g.toTake} place${g.toTake > 1 ? "s" : ""}</span></p>
          ${g.spare ? `<p class="match-meta">➕ ${g.spare} place${g.spare > 1 ? "s" : ""} en trop — ${spareHint(g)}</p>` : ""}
          ${g.members.length
            ? `<ul class="player-list" style="margin-top:8px">${g.members.map(({ p, idx }) => responseLine(p, idx, g.spare)).join("")}</ul>`
            : `<p class="match-meta" style="margin-top:8px">Personne n'a encore répondu pour ce point.</p>`}
        </div>`).join("")
      : isAdmin
        ? `<p class="empty">Aucun point de rdv.<br>Ajoutez-en un via « Modifier le match ».</p>`
        : ""}

    ${showForm ? `
    <div class="card">
      <h2 style="margin-top:0">${editingOther ? "Modifier la réponse" : "Ma réponse"}</h2>
      <label>Nom de l'accompagnateur</label>
      <input id="r-name" value="${esc(formName)}" placeholder="Prénom ou nom de famille">
      <label>Je conduis ?</label>
      <div class="choice-group">
        <button id="c-yes" class="${myResponse.car === "yes" ? "selected-yes" : ""}">🚗 Oui</button>
        <button id="c-no" class="${myResponse.car === "no" ? "selected-no" : ""}">Non</button>
      </div>
      <div id="seats-block" ${myResponse.car === "yes" ? "" : "hidden"}>
        <label>Nombre de places</label>
        <p class="match-meta" style="margin: 0 0 6px;">Sans compter votre enfant joueur.</p>
        <input id="r-seats" type="number" min="0" max="8" value="${myResponse.seats}">
      </div>
      <div id="unused-block" ${myResponse.car === "yes" ? "" : "hidden"}>
        <label>Si ma voiture n'est finalement pas utile</label>
        <div class="choice-group">
          <button id="u-come" class="${myResponse.ifUnused !== "stay" ? "selected-yes" : ""}">Je viens quand même</button>
          <button id="u-stay" class="${myResponse.ifUnused === "stay" ? "selected-no" : ""}">Je peux rester</button>
        </div>
      </div>
      ${rdvs.length > 1 ? `
      <label>Point de départ</label>
      <select id="r-rdv">${rdvs
        .map((r, i) => `<option value="${i}" ${rdvIndexOf(myResponse, rdvs.length) === i ? "selected" : ""}>${esc(rdvLabel(r))}</option>`)
        .join("")}</select>` : ""}
      <div class="section-actions">
        ${mineIdx >= 0 || editIndex != null ? `<button class="btn-secondary" id="r-cancel">Annuler</button>` : ""}
        <button class="btn-primary" id="r-save">Enregistrer</button>
      </div>
    </div>` : `
    <div class="section-actions">
      <button class="btn-secondary" id="r-edit">✏️ Modifier ma réponse</button>
    </div>`}

    ${rdvs.length
      ? accomp.length ? `<p class="match-meta">Touchez une réponse pour la corriger.</p>` : ""
      : accomp.length
        ? `<h2>Réponses (${accomp.length})</h2>
           <div class="card"><ul class="player-list">${accomp
             .map((p, i) => responseLine(p, i, 0)).join("")}</ul></div>
           <p class="match-meta">Touchez une réponse pour la corriger.</p>`
        : `<p class="empty">Personne n'a encore répondu.</p>`}

    <div class="section-actions">
      <button class="btn-primary" id="share">📤 Partager le sondage</button>
    </div>
    ${isAdmin ? `
    <div class="section-actions">
      <button class="btn-secondary" id="edit">Modifier le match</button>
      <button class="btn-danger" id="delete">Supprimer</button>
    </div>` : ""}`;

  document.getElementById("back").onclick = () => renderList();
  if (isAdmin) {
    document.getElementById("edit").onclick = () => renderForm(m);
    document.getElementById("delete").onclick = () => {
      if (!confirm("Supprimer ce match ?")) return;
      withBusy(async () => {
        await Store.deleteMatch(m);
        renderList();
      }, "Suppression impossible");
    };
  }

  const rerender = () => renderDetail(matchId);

  app.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => renderDetail(matchId, Number(el.dataset.edit));
  });
  const editBtn = document.getElementById("r-edit");
  if (editBtn) editBtn.onclick = () => renderDetail(matchId, mineIdx);
  const cancelBtn = document.getElementById("r-cancel");
  if (cancelBtn) cancelBtn.onclick = () => rerender();

  function keepForm() {
    if (!editingOther) myName = document.getElementById("r-name").value;
    const seatsInput = document.getElementById("r-seats");
    if (seatsInput) myResponse.seats = Number(seatsInput.value) || 0;
    const rdvInput = document.getElementById("r-rdv");
    if (rdvInput) myResponse.rdv = Number(rdvInput.value) || 0;
  }

  if (showForm) {
    document.getElementById("c-yes").onclick = () => { myResponse.car = "yes"; keepForm(); redrawForm(); };
    document.getElementById("c-no").onclick = () => { myResponse.car = "no"; keepForm(); redrawForm(); };
    document.getElementById("u-come").onclick = () => { myResponse.ifUnused = "come"; keepForm(); redrawForm(); };
    document.getElementById("u-stay").onclick = () => { myResponse.ifUnused = "stay"; keepForm(); redrawForm(); };

    // Bascule oui/non sans re-rendre toute la page (le nom saisi est conservé).
    function redrawForm() {
      document.getElementById("c-yes").className = myResponse.car === "yes" ? "selected-yes" : "";
      document.getElementById("c-no").className = myResponse.car === "no" ? "selected-no" : "";
      document.getElementById("seats-block").hidden = myResponse.car !== "yes";
      document.getElementById("unused-block").hidden = myResponse.car !== "yes";
      document.getElementById("u-come").className = myResponse.ifUnused !== "stay" ? "selected-yes" : "";
      document.getElementById("u-stay").className = myResponse.ifUnused === "stay" ? "selected-no" : "";
    }

    document.getElementById("r-save").onclick = () => {
      keepForm();
      const name = document.getElementById("r-name").value.trim();
      if (!name) return toast("Indiquez votre nom");
      if (!myResponse.car) return toast("Je conduis : oui ou non ?");
      const rdvIdx = rdvIndexOf(myResponse, Math.max(1, rdvs.length));
      const answer = {
        name,
        car: myResponse.car,
        seats: myResponse.seats,
        ifUnused: myResponse.ifUnused,
        rdv: rdvIdx,
      };
      if (!editingOther) {
        myName = name;
        try { localStorage.setItem(STORAGE_KEY + ":name", name); } catch (e) {}
        saveCarPref({ car: answer.car, seats: myResponse.seats, ifUnused: myResponse.ifUnused });
      }
      withBusy(async () => {
        // En base, le nom vit sur le profil : on le met à jour à part.
        if (Store.mode === "db" && !editingOther) await DB.setDisplayName(name);
        const point = rdvs[rdvIdx];
        await Store.saveResponse(m, answer, point ? point.id : null, editingOther ? editing : null);
        toast("Réponse enregistrée ✔");
        rerender();
      }, "Enregistrement impossible");
    };
  }

  document.getElementById("share").onclick = async () => {
    const url = Store.shareUrl(m);
    const lines = [];
    if (m.arrivalTime) lines.push(`🏟️ Sur place à ${m.arrivalTime.replace(":", "h")}`);
    for (const r of rdvs) {
      const n = Number(r.toTake) || 0;
      lines.push(`🅿️ ${rdvLabel(r)}${n ? ` · ${n} joueur${n > 1 ? "s" : ""} à prendre` : ""}`);
    }
    const text = `🚌 Sondage transport${m.category ? " " + m.category : ""} — ${matchTitle(m)} (${formatDate(m.date, m.time)})`
      + (lines.length ? "\n" + lines.join("\n") : "")
      + `\nRéponds ici : ${url}`
      + (Store.mode === "db" ? "\n(le lien inscrit aussi aux prochains matchs de l'équipe)" : "");
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

// Lien d'invitation : #t=<jeton>[&m=<match>]. L'adhésion se fait une
// fois ; ensuite l'appareil retrouve l'équipe tout seul.
async function handleInvite() {
  const hash = location.hash;
  if (!hash.startsWith("#t=")) return false;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("t");
  const wanted = params.get("m");
  history.replaceState(null, "", location.pathname + location.search);
  if (!token || Store.mode !== "db") return false;
  await withBusy(async () => {
    const teamId = await DB.joinTeam(token, myName || null);
    await Store.loadTeams();
    await Store.selectTeam(teamId);
    watchTeam();
    if (wanted && state.matches.some((m) => m.id === wanted)) renderDetail(wanted);
    else { renderList(); toast("Bienvenue dans l'équipe ✔"); }
  }, "Lien d'invitation invalide");
  return true;
}

// Les changements des autres téléphones rafraîchissent l'écran, sauf
// pendant la saisie d'une réponse pour ne pas effacer ce qui est tapé.
function watchTeam() {
  Store.watch(() => {
    if (document.getElementById("r-name") || document.getElementById("f-opponent")) return;
    const open = document.querySelector("[data-match]") ? null : currentMatchId;
    withBusy(async () => {
      await Store.reload();
      if (open && state.matches.some((m) => m.id === open)) renderDetail(open);
      else renderList();
    });
  });
}

let currentMatchId = null;

function updateFooter() {
  const el = document.getElementById("footer-note");
  if (!el) return;
  el.textContent = Store.mode === "db"
    ? "Les réponses sont partagées avec l'équipe et se mettent à jour en direct."
    : "Mode hors ligne — les données restent dans ce navigateur et se partagent par lien.";
}

async function start() {
  try {
    await Store.boot();
  } catch (e) {
    console.error(e);
    toast("Base injoignable — mode local");
  }
  updateFooter();
  if (await handleInvite()) return;
  if (Store.mode === "db") {
    await Store.reload();
    watchTeam();
    renderList();
  } else {
    const importedId = handleIncomingLink();
    if (importedId) renderDetail(importedId);
    else renderList();
  }
}

// Un lien ouvert alors que l'app tourne déjà ne change que le #, sans
// recharger la page : on traite aussi ce cas.
window.addEventListener("hashchange", () => {
  withBusy(async () => {
    if (await handleInvite()) return;
    const importedId = handleIncomingLink();
    if (importedId) renderDetail(importedId);
  });
});

start();
