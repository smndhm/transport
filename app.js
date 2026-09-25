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
// « Voir comme un parent » : masque tous les outils d'organisateur sans
// rien changer aux droits réels, pour vérifier ce que l'équipe verra.
let parentPreview = false;
try { parentPreview = localStorage.getItem(STORAGE_KEY + ":asparent") === "1"; } catch (e) {}

const rawAdmin = (() => {
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
// en mode local, du paramètre ?admin. L'aperçu parent annule les deux.
let legacyAdmin = rawAdmin && !parentPreview;
let isAdmin = legacyAdmin;

function setParentPreview(on) {
  parentPreview = on;
  try {
    if (on) localStorage.setItem(STORAGE_KEY + ":asparent", "1");
    else localStorage.removeItem(STORAGE_KEY + ":asparent");
  } catch (e) { /* stockage indisponible : l'aperçu vaut pour la session */ }
  legacyAdmin = rawAdmin && !parentPreview;
  isAdmin = Store.mode === "db"
    ? Boolean(Store.team && Store.team.role === "organizer" && !parentPreview)
    : legacyAdmin;
}

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
    isAdmin = Boolean(this.team && this.team.role === "organizer" && !parentPreview);
  },

  async selectTeam(id) {
    this.team = this.teams.find((t) => t.id === id) || null;
    isAdmin = Boolean(this.team && this.team.role === "organizer" && !parentPreview);
    this.rememberTeam(this.team ? this.team.id : null);
    await this.reload();
  },

  // Recharge les matchs de l'équipe courante. Renvoie false si la base
  // n'a pas répondu : c'est à l'appelant de dire ce que ça implique, car
  // « je n'ai pas pu lire » et « je n'ai pas pu écrire » ne se valent pas.
  // Le cache local évite un écran vide au bord d'un terrain.
  lastError: null,

  async reload(retry = true) {
    if (this.mode !== "db") return true;
    if (!this.team) { state.matches = []; return true; }
    try {
      state.matches = await DB.loadTeam(this.team.id, this.team.name);
      DB.cacheWrite(this.team.id, state.matches);
      this.lastError = null;
      return true;
    } catch (e) {
      // Une coupure brève ne devrait pas coûter un écran périmé.
      if (retry) {
        await new Promise((r) => setTimeout(r, 1200));
        return this.reload(false);
      }
      this.lastError = e;
      const cached = DB.cacheRead(this.team.id);
      state.matches = cached || [];
      return false;
    }
  },

  // Après une écriture réussie : si la relecture échoue, la donnée est
  // bien enregistrée, seul l'affichage est en retard. Le dire tel quel.
  viewStale: false,

  async refreshAfterWrite() {
    this.viewStale = false;
    if (await this.reload()) return;
    this.viewStale = true;
    const detail = describeError(this.lastError);
    showError("Enregistré, mais la relecture a échoué" + detail);
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
      await this.refreshAfterWrite();
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
      await this.refreshAfterWrite();
      return;
    }
    state.matches = state.matches.filter((x) => x.id !== m.id);
    saveState();
  },

  async saveResponse(m, answer, pointId, editing) {
    if (this.mode === "db") {
      await DB.saveResponse(m.dbId, pointId, answer, editing);
      await this.refreshAfterWrite();
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

  // Renumérote un groupe de réponses dans l'ordre fourni.
  async setOrder(m, entries) {
    entries.forEach((e, i) => { e.position = i + 1; });
    if (this.mode === "db") {
      await DB.setResponsePositions(entries.map((e) => e.id));
      await this.refreshAfterWrite();
      return;
    }
    saveState();
  },

  async deleteResponse(m, entry) {
    if (this.mode === "db") {
      await DB.deleteResponse(entry.id);
      await this.refreshAfterWrite();
      return;
    }
    m.players = m.players.filter((x) => x !== entry);
    saveState();
  },

  async importEvents(events) {
    if (this.mode === "db") {
      const count = await DB.importMatches(this.team.id, events);
      await this.refreshAfterWrite();
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
// L'identité d'un événement du calendrier : son UID iCal, ou à défaut
// l'adversaire et la date. data.js range la même valeur en base.
function eventUid(ev) {
  return ev.uid || ev.summary + ev.start.date;
}

// Un événement déjà importé : en base on compare l'uid Kalisport rangé
// sur le match, en local l'identifiant dérivé de ce même uid.
function isKnownEvent(ev) {
  if (Store.mode === "db") {
    const uid = eventUid(ev);
    return state.matches.some((m) => m.externalUid === uid);
  }
  return state.matches.some((m) => m.id === icsId(ev));
}

function icsId(ev) {
  const s = eventUid(ev);
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
function responseLine(p, idx, spare, used, move) {
  const seats = Number(p.seats) || 0;
  const tag = carMode(p) !== "no" && spare
    ? p.ifUnused === "stay" ? ` <span class="tag-stay">peut rester</span>` : ` <span class="tag-come">vient quand même</span>`
    : "";
  let detail;
  if (carMode(p) === "no") {
    detail = "🙋 sans voiture";
  } else if (used === 0) {
    // Cette voiture dépasse le besoin : elle n'emmène personne.
    detail = `<span class="seat-unused">🚗 non nécessaire</span> <span class="match-meta">(${seats} pl.)</span>${tag}`;
  } else if (used != null && used < seats) {
    detail = `🚗 ${used} place${used > 1 ? "s" : ""} <span class="match-meta">sur ${seats}</span>${tag}`;
  } else {
    detail = `🚗 ${seats} place${seats > 1 ? "s" : ""}${tag}`;
  }
  // Toute réponse est corrigeable par n'importe quel membre de l'équipe :
  // c'est un covoiturage entre parents, pas un registre.
  return `<li data-edit="${idx}" style="cursor:pointer"><span>${move || ""}${esc(p.name)}</span>` +
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
// Une écriture en cours ne doit pas pouvoir être relancée : sur un
// réseau lent, rien ne bouge à l'écran et on retape sur le bouton — trois
// tapes sur « Créer l'équipe » créaient trois équipes. Les boutons sont
// désactivés le temps de l'aller-retour, ce qui se voit aussi.
let busy = false;
async function withBusy(fn, errorMsg) {
  if (busy) return;
  busy = true;
  const frozen = [...document.querySelectorAll("#app button")].filter((b) => !b.disabled);
  frozen.forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    console.error(e);
    const text = (errorMsg || "Erreur") + describeError(e);
    toast(text);
    showError(text);
  } finally {
    busy = false;
    // Un rendu a pu remplacer l'écran entre-temps : on ne réactive que
    // les boutons encore présents.
    frozen.forEach((b) => { if (b.isConnected) b.disabled = false; });
  }
}

// Un toast disparaît et ne se sélectionne pas : l'erreur reste aussi
// affichée en haut de l'écran, avec de quoi la copier.
function showError(text) {
  const old = document.getElementById("err-banner");
  if (old) old.remove();
  const box = document.createElement("div");
  box.id = "err-banner";
  box.className = "card err-banner";
  box.style.maxWidth = "560px";
  box.style.margin = "16px auto 0";
  box.innerHTML = `<p class="err-title">Erreur</p>
    <pre class="err-text">${esc(text)}</pre>
    <div class="section-actions">
      <button class="btn-secondary" id="err-copy">📋 Copier</button>
      <button class="btn-link" id="err-hide">Masquer</button>
    </div>`;
  // Hors de #app : les écrans se redessinent, l'erreur doit rester.
  app.parentNode.insertBefore(box, app);
  document.getElementById("err-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast("Erreur copiée 📋"); }
    catch (e) { prompt("Copiez ce message :", text); }
  };
  document.getElementById("err-hide").onclick = () => box.remove();
}

// Les erreurs PostgREST portent un code et parfois un indice : les
// afficher évite d'avoir à ouvrir la console pour comprendre.
function describeError(e) {
  if (!e) return "";
  const parts = [e.message, e.code ? "[" + e.code + "]" : "", e.hint || e.details || ""]
    .map((x) => (x || "").toString().trim())
    .filter(Boolean);
  return parts.length ? " — " + parts.join(" ") : "";
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

  // En mode base, les actions de création sont dans la carte de
  // l'équipe : elles portent sur cette catégorie et pas ailleurs.
  let html = teamHeader(isAdmin ? adminActions() : "");
  if (Store.mode !== "db") {
    if (isAdmin) html += adminActions();
    const toggle = previewToggle();
    if (toggle) html += `<div class="section-actions">${toggle}</div>`;
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
    // En mode base, une seule catégorie est affichée à la fois : son nom
    // est déjà en tête d'écran, inutile de le répéter.
    if (Store.mode === "db") return list.map((m) => matchCard(m, past)).join("");
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

function adminActions() {
  return `<div class="section-actions">
      <button class="btn-primary" id="new-match">+ Nouveau match</button>
      <button class="btn-secondary" id="import-ics">📥 Import Kalisport</button>
    </div>` +
    (savedIcsUrl ? `<div class="section-actions">
      <button class="btn-secondary" id="refresh-ics">🔄 Actualiser depuis Kalisport</button>
    </div>` : "");
}

// En mode base : l'équipe courante, le sélecteur s'il y en a plusieurs,
// les actions de création, et le lien d'invitation pour l'organisateur.
function teamHeader(actions) {
  if (Store.mode !== "db") return "";
  if (!Store.team) {
    return legacyAdmin
      ? `<div class="card">
           <h2 style="margin-top:0">Première équipe</h2>
           <p class="match-meta">Créez une catégorie (U11, U13…) puis partagez son lien aux parents.</p>
           <label>Nom de la catégorie</label>
           <input id="t-name" placeholder="Ex : U13">
           <div class="section-actions">
             <button class="btn-primary" id="t-create">Créer l'équipe</button>
           </div>
           <div class="section-actions">
             <button class="btn-link" id="t-diag">🩺 Diagnostic</button>
           </div>
         </div>`
      : `<p class="empty">Aucune équipe.<br>Ouvrez le lien d'invitation envoyé par l'organisateur.</p>
         ${previewToggle() ? `<div class="section-actions">${previewToggle()}</div>` : ""}`;
    // (previewToggle() rend la même chaîne deux fois : pas d'effet de bord)
  }
  const others = Store.teams.length > 1;
  return `<div class="card">
    <p class="match-title" style="margin:0">${esc(Store.team.name)}
      ${isAdmin ? '<span class="badge home">organisateur</span>' : ""}</p>
    ${others ? `<label>Équipe</label><select id="t-switch">${Store.teams
      .map((t) => `<option value="${esc(t.id)}" ${t.id === Store.team.id ? "selected" : ""}>${esc(t.name)}</option>`)
      .join("")}</select>` : ""}
    ${actions || ""}
    <div class="section-actions">
      ${isAdmin ? `<button class="btn-secondary" id="t-invite">🔗 Inviter les parents</button>` : ""}
    </div>
    <div class="section-actions">
      ${legacyAdmin ? `<button class="btn-link" id="t-new">+ Nouvelle équipe</button>` : ""}
      ${legacyAdmin ? `<button class="btn-link" id="t-diag">🩺 Diagnostic</button>` : ""}
      ${previewToggle()}
    </div>
    ${isAdmin ? `<div class="section-actions">
      <button class="btn-danger" id="t-del">🗑 Supprimer cette équipe</button>
    </div>` : ""}
  </div>`;
}

// N'apparaît que pour qui a réellement les outils d'organisateur : le
// paramètre ?admin, ou le rôle organisateur dans l'équipe courante — ce
// rôle reste vrai pendant l'aperçu, sinon le bouton retour disparaîtrait.
function previewToggle() {
  const organizer = rawAdmin || Boolean(Store.team && Store.team.role === "organizer");
  if (!organizer) return "";
  return parentPreview
    ? `<button class="btn-link" id="t-preview">↩︎ Revenir en organisateur</button>`
    : `<button class="btn-link" id="t-preview">👁 Voir comme un parent</button>`;
}

// Deux équipes du même nom, c'est presque toujours un bouton tapé deux
// fois : on demande confirmation plutôt que d'empêcher (une entente peut
// légitimement avoir deux groupes homonymes).
function confirmDuplicate(name) {
  const twin = Store.teams.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!twin) return true;
  return confirm(`Une équipe « ${twin.name} » existe déjà.\n\nEn créer une seconde du même nom ?`);
}

function createTeamNamed(name) {
  if (!confirmDuplicate(name)) return;
  withBusy(async () => {
    await DB.createTeam(name, null, myName || null);
    await Store.loadTeams();
    await Store.reload();
    renderList();
  }, "Création impossible");
}

function bindTeamHeader() {
  const create = document.getElementById("t-create");
  if (create) {
    create.onclick = () => {
      const name = document.getElementById("t-name").value.trim();
      if (!name) return toast("Donnez un nom à l'équipe");
      createTeamNamed(name);
    };
  }
  const sw = document.getElementById("t-switch");
  if (sw) sw.onchange = () => withBusy(async () => { await Store.selectTeam(sw.value); renderList(); }, "Changement impossible");

  const nw = document.getElementById("t-new");
  if (nw) nw.onclick = () => {
    const name = prompt("Nom de la nouvelle catégorie (ex : U15) :");
    if (!name || !name.trim()) return;
    createTeamNamed(name.trim());
  };

  const del = document.getElementById("t-del");
  if (del) del.onclick = () => {
    const n = state.matches.length;
    const quoi = n ? `${n} match${n > 1 ? "s" : ""} et toutes les réponses` : "aucun match";
    if (!confirm(`Supprimer l'équipe « ${Store.team.name} » ?\n\n`
      + `Cela efface ${quoi}. Les parents ne la verront plus.\nC'est définitif.`)) return;
    withBusy(async () => {
      const how = await DB.deleteTeam(Store.team.id);
      await Store.loadTeams();
      await Store.reload();
      renderList();
      toast(how === "supprimée"
        ? "Équipe supprimée"
        : "Équipe vidée et retirée des listes (migration 0004 non passée)");
    }, "Suppression impossible");
  };

  const prev = document.getElementById("t-preview");
  if (prev) prev.onclick = () => {
    setParentPreview(!parentPreview);
    toast(parentPreview ? "Vue parent — les outils sont masqués" : "Mode organisateur rétabli");
    renderList();
  };

  const diag = document.getElementById("t-diag");
  if (diag) diag.onclick = () => renderDiag();

  const inv = document.getElementById("t-invite");
  if (inv) inv.onclick = async () => {
    const url = Store.shareUrl(null);
    const text = `🚌 Transport ${Store.team.name} — inscris-toi une fois, tu verras tous les déplacements :\n${url}`;
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { /* annulé */ } }
    try { await navigator.clipboard.writeText(text); toast("Lien d'invitation copié 📋"); }
    catch (e) { prompt("Copiez ce lien :", url); }
  };
}

// Écran de diagnostic : rejoue la chaîne étape par étape et produit un
// rapport sélectionnable, plutôt qu'un message fugace.
function renderDiag() {
  app.innerHTML = `
    <button class="btn-link" id="back">← Retour</button>
    <div class="card">
      <h2 style="margin-top:0">🩺 Diagnostic</h2>
      <p class="match-meta">Vérifie chaque étape entre l'app et la base.</p>
      <div id="diag-out"><p class="empty">Analyse en cours…</p></div>
      <div class="section-actions">
        <button class="btn-secondary" id="diag-again">Relancer</button>
        <button class="btn-primary" id="diag-copy">📋 Copier le rapport</button>
      </div>
      <label>Test d'écriture</label>
      <p class="match-meta" style="margin:0 0 6px">Crée une équipe pour de vrai, et affiche l'erreur exacte si ça échoue.</p>
      <div class="section-actions">
        <button class="btn-secondary" id="diag-write">Tester la création d'équipe</button>
      </div>
    </div>`;

  document.getElementById("back").onclick = () => renderList();

  let report = "";
  const out = document.getElementById("diag-out");

  const run = async () => {
    out.innerHTML = `<p class="empty">Analyse en cours…</p>`;
    const steps = await DB.diagnose(Store.team ? Store.team.id : null);
    report = steps.map((s) => `${s.ok ? "OK " : "KO "} ${s.label}${s.detail ? " : " + s.detail : ""}`).join("\n");
    out.innerHTML = `<ul class="player-list">${steps
      .map((s) => `<li><span>${s.ok ? "✔" : "✘"} ${esc(s.label)}</span></li>` +
        (s.detail ? `<li style="border:none;padding-top:0"><span class="match-meta">${esc(s.detail)}</span></li>` : ""))
      .join("")}</ul>`;
  };

  document.getElementById("diag-again").onclick = () => withBusy(run, "Diagnostic impossible");
  document.getElementById("diag-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(report); toast("Rapport copié 📋"); }
    catch (e) { prompt("Copiez ce rapport :", report); }
  };
  document.getElementById("diag-write").onclick = () => withBusy(async () => {
    const res = await DB.testCreateTeam("Test diagnostic");
    report += `\n${res.ok ? "OK " : "KO "} Création d'équipe : ${res.detail}`;
    out.innerHTML += `<p class="match-meta" style="margin-top:8px">${res.ok ? "✔" : "✘"} Création d'équipe : ${esc(res.detail)}</p>`;
    if (!res.ok) showError("Création d'équipe — " + res.detail);
    else { await Store.loadTeams(); toast("Équipe de test créée ✔"); }
  }, "Test impossible");

  withBusy(run, "Diagnostic impossible");
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
      <h2 style="margin-top:0">${match ? "Modifier le match" : "Nouveau match"}${
        Store.mode === "db" && Store.team ? ` <span class="badge home">${esc(Store.team.name)}</span>` : ""}</h2>
      ${Store.mode === "db" ? "" : `
      <label>Catégorie</label>
      <input id="f-category" value="${esc(m.category || "")}" placeholder="Ex : U13" list="f-cats">
      <datalist id="f-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`}
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
      category: Store.mode === "db"
        ? (Store.team ? Store.team.name : "")
        : document.getElementById("f-category").value.trim(),
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
          const known = isKnownEvent(ev);
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
        toast(n
          ? `${n} match${n > 1 ? "s" : ""} importé${n > 1 ? "s" : ""} ✔`
          : "Rien de nouveau — ces matchs étaient déjà dans la liste");
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
  const accomp = m.players
    .filter((p) => p.status !== "absent")
    .sort((x, y) => (Number(x.position) || 0) - (Number(y.position) || 0));
  // Ma réponse : celle rattachée à mon compte en base, à mon nom en local.
  const mineIdx = Store.mode === "db"
    ? accomp.findIndex((p) => p.profileId && p.profileId === DB.me())
    : accomp.findIndex((p) => p.name.trim().toLowerCase() === myName.trim().toLowerCase());

  // Trois façons d'ouvrir le formulaire : « mine » pour sa propre
  // réponse, « new » pour celle de quelqu'un d'autre, un indice pour
  // corriger une ligne existante. Fermé le reste du temps : on arrive
  // sur le récapitulatif, pas sur un formulaire.
  const adding = editIndex === "new";
  const own = editIndex === "mine";
  const editingIdx = adding || own ? null : editIndex;
  const editing = adding ? null
    : own ? (mineIdx >= 0 ? accomp[mineIdx] : null)
    : editingIdx != null ? accomp[editingIdx] : null;
  const showForm = editIndex != null;
  const editingOther = editingIdx != null && editingIdx !== mineIdx;
  // Une réponse « invitée » n'appartient à aucun compte : son nom est libre.
  const asGuest = adding || (editing ? (Store.mode === "db" ? Boolean(editing.isGuest) : editingOther) : false);

  if (editing) {
    myResponse = { car: carMode(editing) === "no" ? "no" : "yes", seats: editing.seats ?? 3, rdv: Number(editing.rdv) || 0, ifUnused: editing.ifUnused || "come" };
  } else {
    const pref = loadCarPref();
    myResponse = pref
      ? { car: adding ? null : pref.car ?? null, seats: pref.seats ?? 3, rdv: 0, ifUnused: pref.ifUnused || "come" }
      : { car: null, seats: 3, rdv: 0, ifUnused: "come" };
  }
  const formName = adding ? "" : editing && (editingOther || asGuest) ? editing.name : myName;
  // On ne renomme pas le compte d'un autre parent depuis ce formulaire.
  const nameLocked = Store.mode === "db" && Boolean(editing) && !editing.isGuest && editing.profileId !== DB.me();

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

    // Les places sont affectées dans l'ordre affiché, jusqu'à couvrir le
    // besoin : au-delà, une voiture n'emmène personne.
    let remaining = atToTake;
    for (const entry of members) {
      if (carMode(entry.p) === "no") { entry.used = null; continue; }
      entry.used = Math.min(Number(entry.p.seats) || 0, remaining);
      remaining -= entry.used;
    }

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
            ? `<ul class="player-list" style="margin-top:8px">${g.members
                .map((entry, j) => responseLine(entry.p, entry.idx, g.spare, entry.used,
                  isAdmin && g.members.length > 1 && (Store.mode !== "db" || DB.supportsOrdering())
                    ? `<span class="move-btns"><button class="move" data-move="${g.i}:${j}:-1"${j === 0 ? " disabled" : ""}>↑</button><button class="move" data-move="${g.i}:${j}:1"${j === g.members.length - 1 ? " disabled" : ""}>↓</button></span>`
                    : ""))
                .join("")}</ul>`
            : `<p class="match-meta" style="margin-top:8px">Personne n'a encore répondu pour ce point.</p>`}
        </div>`).join("")
      : isAdmin
        ? `<p class="empty">Aucun point de rdv.<br>Ajoutez-en un via « Modifier le match ».</p>`
        : ""}

    ${showForm ? `
    <div class="card">
      <h2 style="margin-top:0">${adding ? "Ajouter une réponse"
        : editingOther || asGuest ? "Modifier la réponse" : "Ma réponse"}</h2>
      ${adding ? `<p class="match-meta">Pour un parent qui a répondu autrement, ou une seconde voiture de votre famille.</p>` : ""}
      <label>Nom de l'accompagnateur</label>
      <input id="r-name" value="${esc(formName)}" placeholder="Prénom ou nom de famille"${nameLocked ? " disabled" : ""}>
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
        <button class="btn-secondary" id="r-cancel">Annuler</button>
        <button class="btn-primary" id="r-save">Enregistrer</button>
      </div>
      ${editing ? `<div class="section-actions">
        <button class="btn-danger" id="r-delete">Supprimer cette réponse</button>
      </div>` : ""}
    </div>` : ""}
    ${showForm ? "" : `<div class="section-actions">
      ${mineIdx < 0
        ? `<button class="btn-primary" id="r-mine">➕ Ajouter ma réponse</button>`
        : `<button class="btn-secondary" id="r-add">➕ Ajouter une voiture</button>`}
    </div>`}
    ${!isAdmin && Store.mode === "db" ? `<div class="section-actions">
      <button class="btn-link" id="p-add">➕ Ajouter un point de rdv</button>
    </div>` : ""}

    ${rdvs.length
      ? accomp.length ? `<p class="match-meta">Touchez une réponse pour la corriger.</p>` : ""
      : accomp.length
        ? `<h2>Réponses (${accomp.length})</h2>
           <div class="card"><ul class="player-list">${accomp
             .map((p, i) => responseLine(p, i, 0, null, "")).join("")}</ul></div>
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

  app.querySelectorAll("[data-move]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation(); // ne pas ouvrir l'édition de la ligne
      const [gi, j, dir] = el.dataset.move.split(":").map(Number);
      const group = perRdv[gi].members.map((x) => x.p);
      const target = j + dir;
      if (target < 0 || target >= group.length) return;
      [group[j], group[target]] = [group[target], group[j]];
      withBusy(async () => {
        await Store.setOrder(m, group);
        rerender();
      }, "Réordonnancement impossible");
    };
  });
  const addBtn = document.getElementById("r-add");
  if (addBtn) addBtn.onclick = () => renderDetail(matchId, "new");

  const mineBtn = document.getElementById("r-mine");
  if (mineBtn) mineBtn.onclick = () => renderDetail(matchId, "mine");

  // « 13h15 », « 13:15 » ou « 1315 » : on accepte, la base veut HH:MM.
  const asTime = (v) => {
    const d = (v || "").replace(/\D/g, "");
    if (d.length < 3) return "";
    const h = d.slice(0, d.length - 2), min = d.slice(-2);
    if (Number(h) > 23 || Number(min) > 59) return "";
    return String(h).padStart(2, "0") + ":" + min;
  };

  // Un point de rdv oublié n'a pas à attendre le coach.
  const pAdd = document.getElementById("p-add");
  if (pAdd) pAdd.onclick = () => {
    const place = prompt("Lieu du point de rdv (ex : Parking du gymnase) :");
    if (!place || !place.trim()) return;
    const time = prompt("Heure de départ (ex : 13:15) — laissez vide si vous ne savez pas :") || "";
    const toTake = prompt("Combien de joueurs à prendre à ce point ? (0 si vous ne savez pas)") || "0";
    withBusy(async () => {
      await DB.addMeetingPoint(m.dbId, { place: place.trim(), time: asTime(time), toTake });
      await Store.refreshAfterWrite();
      toast("Point de rdv ajouté ✔");
      rerender();
    }, "Ajout impossible");
  };
  const delBtn = document.getElementById("r-delete");
  if (delBtn) delBtn.onclick = () => {
    if (!confirm(`Supprimer la réponse de ${editing.name} ?`)) return;
    withBusy(async () => {
      await Store.deleteResponse(m, editing);
      toast("Réponse supprimée");
      rerender();
    }, "Suppression impossible");
  };
  const cancelBtn = document.getElementById("r-cancel");
  if (cancelBtn) cancelBtn.onclick = () => rerender();

  function keepForm() {
    if (!editingOther && !asGuest) myName = document.getElementById("r-name").value;
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
        asGuest,
      };
      // Les préférences voiture ne se mémorisent que pour soi-même.
      if (!editingOther && !asGuest) {
        myName = name;
        try { localStorage.setItem(STORAGE_KEY + ":name", name); } catch (e) {}
        saveCarPref({ car: answer.car, seats: myResponse.seats, ifUnused: myResponse.ifUnused });
      }
      withBusy(async () => {
        // En base, mon nom vit sur mon profil : on le met à jour à part.
        if (Store.mode === "db" && !editingOther && !asGuest) await DB.setDisplayName(name);
        const point = rdvs[rdvIdx];
        await Store.saveResponse(m, answer, point ? point.id : null, editing);
        toast(Store.viewStale ? "Enregistré ✔ — affichage pas à jour" : "Réponse enregistrée ✔");
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
    if (!(await Store.reload())) {
      const detail = describeError(Store.lastError);
      toast("Hors ligne — dernières données connues" + detail);
      showError("Lecture de la base impossible" + detail);
    }
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
