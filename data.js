/* Transport — accès aux données (Supabase).
 *
 * Ce module traduit entre les tables du schéma et la forme d'objet que
 * l'app manipule déjà (match.rdvs, match.players…), pour que le reste
 * du code change le moins possible.
 *
 * Identité : session anonyme Supabase, sans mot de passe. Le lien
 * partagé porte le jeton de l'équipe ; join_team() l'échange contre une
 * adhésion, et les règles RLS travaillent ensuite sur auth.uid().
 */

const DB = (() => {
  const CACHE_KEY = "transport-cache-v1";
  let client = null;
  let sessionPromise = null;
  let userId = null;

  function config() {
    return window.TRANSPORT_CONFIG || {};
  }

  // Tant que la configuration est vide, l'app reste en mode local.
  function enabled() {
    const c = config();
    return Boolean(c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  function sb() {
    if (!client) {
      client = window.supabase.createClient(config().supabaseUrl, config().supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    return client;
  }

  // Une seule session anonyme par appareil, réutilisée ensuite.
  function ready() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const { data: existing } = await sb().auth.getSession();
        if (existing.session) {
          userId = existing.session.user.id;
          return userId;
        }
        const { data, error } = await sb().auth.signInAnonymously();
        if (error) throw error;
        userId = data.user.id;
        await ensureProfile();
        return userId;
      })();
    }
    return sessionPromise;
  }

  function me() {
    return userId;
  }

  // Le profil est la ligne de référence de cet appareil : team_members et
  // responses y pointent. On la crée dès la session, sans attendre qu'une
  // autre opération en ait besoin.
  async function ensureProfile(name) {
    if (!userId) return;
    const { error } = await sb()
      .from("profiles")
      .upsert({ id: userId, display_name: name || "Parent" }, { onConflict: "id", ignoreDuplicates: true });
    if (error) console.warn("profil non créé :", error.message);
  }

  // ---------- Traduction base → forme utilisée par l'app ----------

  const hhmm = (t) => (t ? String(t).slice(0, 5) : "");

  function toAppMatch(row, teamName) {
    const points = [...(row.meeting_points || [])].sort((a, b) => a.position - b.position);
    const pointIndex = new Map(points.map((p, i) => [p.id, i]));
    return {
      id: row.id,
      dbId: row.id,
      category: teamName || "",
      opponent: row.opponent,
      date: row.match_date,
      time: hhmm(row.kickoff_time),
      location: row.venue || "",
      arrivalTime: hhmm(row.arrival_time),
      imported: row.external_source === "kalisport",
      externalUid: row.external_uid || null,
      rdvs: points.map((p) => ({
        id: p.id,
        place: p.name,
        time: hhmm(p.departure_time),
        toTake: p.players_expected,
      })),
      players: (row.responses || [])
        // L'ordre décidé par l'organisateur ; à égalité, l'ancienneté.
        .sort((a, b) => ((a.position || 0) - (b.position || 0))
          || String(a.created_at || "").localeCompare(String(b.created_at || "")))
        .map((r) => ({
        id: r.id,
        position: r.position,
        profileId: r.profile_id,
        isGuest: !r.profile_id,
        mine: r.profile_id ? r.profile_id === userId : r.created_by === userId,
        name: r.profile ? r.profile.display_name : (r.guest_name || "?"),
        car: r.drives ? "yes" : "no",
        seats: r.seats,
        ifUnused: r.stays_if_unused ? "stay" : "come",
        rdv: pointIndex.has(r.meeting_point_id) ? pointIndex.get(r.meeting_point_id) : 0,
      })),
    };
  }

  // ---------- Équipes ----------

  async function myTeams() {
    await ready();
    const { data, error } = await sb()
      .from("team_members")
      .select("role, teams ( id, name, season, join_token )");
    if (error) throw error;
    return (data || [])
      .filter((m) => m.teams)
      .map((m) => ({ ...m.teams, role: m.role }));
  }

  async function createTeam(name, season, displayName) {
    await ready();
    await ensureProfile(displayName);
    let { data, error } = await sb().rpc("create_team", {
      p_name: name,
      p_season: season || null,
      p_display_name: displayName || null,
    });
    // Base pas encore migrée : l'ancienne fonction ne prend que deux
    // arguments. Le profil venant d'être créé, elle fonctionne aussi.
    if (error && error.code === "PGRST202") {
      ({ data, error } = await sb().rpc("create_team", { p_name: name, p_season: season || null }));
    }
    if (error) throw error;
    return data;
  }

  // Supprime une équipe et, en cascade, ses matchs, points de rdv,
  // réponses et adhésions.
  //
  // La règle qui l'autorise arrive avec la migration 0004. Sans elle,
  // PostgreSQL ne lève pas d'erreur : la ligne est simplement invisible
  // pour le DELETE, qui n'efface rien. D'où la vérification de ce qui a
  // réellement été supprimé plutôt qu'un test sur l'erreur.
  //
  // En repli on vide l'équipe — matchs puis adhésions, ce que les règles
  // en place permettent déjà à l'organisateur : elle disparaît de toutes
  // les listes, seule sa ligne subsiste, invisible faute de membre.
  async function deleteTeam(teamId) {
    await ready();
    const { data, error } = await sb().from("teams").delete().eq("id", teamId).select("id");
    if (error) throw error;
    if (data && data.length) return "supprimée";

    const { error: matchErr } = await sb().from("matches").delete().eq("team_id", teamId);
    if (matchErr) throw matchErr;
    const { data: left, error: memberErr } = await sb()
      .from("team_members").delete().eq("team_id", teamId).select("profile_id");
    if (memberErr) throw memberErr;
    if (!left || !left.length) throw new Error("la base a refusé la suppression");
    return "vidée";
  }

  // Renvoie l'id de l'équipe rejointe, ou lève si le lien est invalide.
  async function joinTeam(token, displayName) {
    await ready();
    const { data, error } = await sb().rpc("join_team", {
      p_token: token,
      p_display_name: displayName || null,
    });
    if (error) throw error;
    return data;
  }

  async function setDisplayName(name) {
    await ready();
    const { error } = await sb().from("profiles").update({ display_name: name }).eq("id", me());
    if (error) throw error;
  }

  // ---------- Matchs ----------

  // Colonnes de responses apportées par des migrations. Si la base n'a
  // pas encore été migrée, on les retire et on recharge : l'app reste
  // utilisable entre le déploiement du code et l'exécution du SQL, au
  // lieu d'afficher une erreur jusqu'à ce que quelqu'un s'en occupe.
  let optionalCols = ["guest_name", "created_by", "position", "created_at"];

  function matchesSelect() {
    const extra = optionalCols.length ? ", " + optionalCols.join(", ") : "";
    return `
      id, opponent, match_date, kickoff_time, venue, arrival_time,
      external_source, external_uid,
      meeting_points ( id, name, departure_time, players_expected, position ),
      responses ( id, profile_id, meeting_point_id, drives, seats,
                  stays_if_unused${extra},
                  profile:profiles!responses_profile_id_fkey ( display_name ) )
    `;
  }

  async function loadTeam(teamId, teamName) {
    await ready();
    for (let attempt = 0; attempt <= optionalCols.length; attempt++) {
      const { data, error } = await sb()
        .from("matches")
        .select(matchesSelect())
        .eq("team_id", teamId)
        .order("match_date");
      if (!error) return (data || []).map((row) => toAppMatch(row, teamName));

      // « column responses_1.position does not exist » → on retire position.
      const m = error.code === "42703" && /\.(\w+)\s+does not exist/.exec(error.message || "");
      const col = m && m[1];
      if (!col || !optionalCols.includes(col)) throw error;
      console.warn("Colonne absente (migration non appliquée ?) :", col);
      optionalCols = optionalCols.filter((c) => c !== col);
    }
    throw new Error("Lecture impossible");
  }

  // Vrai seulement si la base connaît la colonne : sert à n'afficher les
  // flèches de tri que lorsqu'elles peuvent fonctionner.
  function supportsOrdering() {
    return optionalCols.includes("position");
  }

  async function saveMatch(teamId, m) {
    await ready();
    const payload = {
      team_id: teamId,
      opponent: m.opponent,
      match_date: m.date,
      kickoff_time: m.time || null,
      venue: m.location || null,
      arrival_time: m.arrivalTime || null,
      external_source: m.imported ? "kalisport" : null,
      external_uid: m.externalUid || null,
    };
    const q = m.dbId
      ? sb().from("matches").update(payload).eq("id", m.dbId).select("id").single()
      : sb().from("matches").insert(payload).select("id").single();
    const { data, error } = await q;
    if (error) throw error;
    await saveMeetingPoints(data.id, m.rdvs || []);
    return data.id;
  }

  // Remplace les points de rdv d'un match : ceux qui ont un id sont mis
  // à jour, les nouveaux insérés, les disparus supprimés (les réponses
  // qui y pointaient sont détachées, pas effacées — cf. schéma).
  async function saveMeetingPoints(matchId, rdvs) {
    const { data: existing, error: readErr } = await sb()
      .from("meeting_points").select("id").eq("match_id", matchId);
    if (readErr) throw readErr;

    const keep = new Set();
    let position = 1;
    for (const r of rdvs) {
      const payload = {
        match_id: matchId,
        name: r.place || "Point de rdv",
        departure_time: r.time || null,
        players_expected: Number(r.toTake) || 0,
        position: position++,
      };
      if (r.id) {
        keep.add(r.id);
        const { error } = await sb().from("meeting_points").update(payload).eq("id", r.id);
        if (error) throw error;
      } else {
        const { data, error } = await sb().from("meeting_points").insert(payload).select("id").single();
        if (error) throw error;
        keep.add(data.id);
      }
    }
    const stale = (existing || []).map((p) => p.id).filter((id) => !keep.has(id));
    if (stale.length) {
      const { error } = await sb().from("meeting_points").delete().in("id", stale);
      if (error) throw error;
    }
  }

  async function deleteMatch(matchId) {
    await ready();
    const { error } = await sb().from("matches").delete().eq("id", matchId);
    if (error) throw error;
  }

  // Les uid déjà importés pour cette équipe.
  async function knownUids(teamId) {
    const { data, error } = await sb()
      .from("matches")
      .select("external_uid")
      .eq("team_id", teamId)
      .eq("external_source", "kalisport")
      .not("external_uid", "is", null);
    if (error) throw error;
    return new Set((data || []).map((r) => r.external_uid));
  }

  // Importe des événements Kalisport sans recréer ceux déjà présents.
  //
  // Le dédoublonnage se fait ici et pas par un ON CONFLICT : l'index qui
  // protège l'import est partiel (« where external_uid is not null ») et
  // PostgreSQL refuse de s'en servir pour un ON CONFLICT sans qu'on lui
  // répète la condition — ce que PostgREST ne sait pas envoyer, d'où le
  // 42P10. On lit donc les uid connus et on n'insère que les nouveaux ;
  // l'index reste le garde-fou si deux imports se croisent.
  async function importMatches(teamId, events) {
    await ready();
    const seen = new Set();
    const rows = [];
    for (const ev of events) {
      const uid = ev.uid || ev.summary + ev.start.date;
      // Le même uid deux fois dans le fichier : une seule ligne.
      if (seen.has(uid)) continue;
      seen.add(uid);
      rows.push({
        team_id: teamId,
        opponent: ev.summary,
        match_date: ev.start.date,
        kickoff_time: ev.start.time || null,
        venue: ev.location || null,
        external_source: "kalisport",
        external_uid: uid,
      });
    }

    let known = await knownUids(teamId);
    let fresh = rows.filter((r) => !known.has(r.external_uid));
    if (!fresh.length) return 0;

    let { data, error } = await sb().from("matches").insert(fresh).select("id");
    if (error && error.code === "23505") {
      // Un autre appareil a importé entre-temps : on relit et on réessaie.
      known = await knownUids(teamId);
      fresh = fresh.filter((r) => !known.has(r.external_uid));
      if (!fresh.length) return 0;
      ({ data, error } = await sb().from("matches").insert(fresh).select("id"));
    }
    if (error) throw error;
    return (data || []).length;
  }

  // ---------- Réponses ----------

  const REFUS = "cette réponse n'est pas la vôtre — seul son auteur ou l'organisateur peut la modifier";

  async function saveResponse(matchId, pointId, answer, existing) {
    await ready();
    const payload = {
      match_id: matchId,
      meeting_point_id: pointId || null,
      drives: answer.car === "yes",
      seats: answer.car === "yes" ? Number(answer.seats) || 0 : 0,
      stays_if_unused: answer.ifUnused === "stay",
    };

    let q;
    if (existing && existing.id) {
      // Correction d'une réponse existante : on cible la ligne, et on
      // laisse renommer si c'est une réponse saisie pour quelqu'un.
      // Comme pour la suppression, un UPDATE sur une ligne non couverte
      // par les règles ne touche rien sans lever d'erreur : on vérifie.
      if (existing.isGuest) payload.guest_name = answer.name;
      const { data, error: upErr } = await sb()
        .from("responses").update(payload).eq("id", existing.id).select("id");
      if (upErr) throw upErr;
      if (!data || !data.length) throw new Error(REFUS);
      return;
    } else if (answer.asGuest) {
      // Réponse au nom de quelqu'un d'autre : pas de profil, un nom libre.
      q = sb().from("responses").insert({ ...payload, guest_name: answer.name });
    } else {
      q = sb().from("responses")
        .upsert({ ...payload, profile_id: me() }, { onConflict: "match_id,profile_id" });
    }
    const { error } = await q;
    if (error) throw error;
  }

  // Renumérote les réponses d'un point de rdv dans l'ordre fourni.
  async function setResponsePositions(ids) {
    await ready();
    for (let i = 0; i < ids.length; i++) {
      const { error } = await sb().from("responses").update({ position: i + 1 }).eq("id", ids[i]);
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") {
          throw new Error("La base n'a pas encore la colonne d'ordre (migration 0003)");
        }
        throw error;
      }
    }
  }

  // Une ligne que les règles d'accès ne couvrent pas n'est pas refusée :
  // elle est invisible. Le DELETE n'efface alors rien et n'annonce aucune
  // erreur — l'app croyait avoir supprimé. On regarde donc ce qui a
  // réellement disparu.
  async function deleteResponse(id) {
    await ready();
    const { data, error } = await sb().from("responses").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || !data.length) throw new Error(REFUS);
  }


  // ---------- Temps réel ----------

  // Rappelle `onChange` dès qu'un match, un point de rdv ou une réponse
  // bouge. Renvoie une fonction pour se désabonner.
  function watch(teamId, onChange) {
    const channel = sb().channel("team:" + teamId);
    for (const table of ["matches", "meeting_points", "responses"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
    }
    channel.subscribe();
    return () => sb().removeChannel(channel);
  }

  // ---------- Cache local ----------

  // L'app reste lisible au bord d'un terrain sans réseau : le dernier
  // état connu est réaffiché en attendant la réponse du serveur.
  function cacheRead(teamId) {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      return all[teamId] || null;
    } catch (e) { return null; }
  }

  function cacheWrite(teamId, matches) {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      all[teamId] = matches;
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* mode privé ou quota : le cache est optionnel */ }
  }

  // ---------- Diagnostic ----------

  function fmt(e) {
    if (!e) return "";
    return [e.message, e.code ? "[" + e.code + "]" : "", e.hint || e.details || ""]
      .map((x) => (x || "").toString().trim()).filter(Boolean).join(" ");
  }

  // Rejoue la chaîne complète, étape par étape, pour situer exactement
  // où ça bloque au lieu de deviner depuis un message fugace.
  async function diagnose() {
    const steps = [];
    const add = (label, ok, detail) => steps.push({ label, ok, detail: detail || "" });
    const c = config();

    add("Configuration présente", Boolean(c.supabaseUrl && c.supabaseAnonKey), c.supabaseUrl || "(vide)");
    add("Client Supabase chargé", Boolean(window.supabase),
        window.supabase ? "" : "le script du CDN n'a pas pu être chargé");
    if (!window.supabase || !c.supabaseUrl) return steps;

    try {
      await ready();
      add("Session anonyme", true, "utilisateur " + userId);
    } catch (e) {
      add("Session anonyme", false, fmt(e) + " — les connexions anonymes sont-elles activées ?");
      return steps;
    }

    try {
      const { data, error } = await sb().from("profiles").select("id, display_name").eq("id", userId);
      if (error) throw error;
      add("Lecture du profil", true, data.length ? "profil « " + data[0].display_name + " »" : "aucun profil");
    } catch (e) {
      add("Lecture du profil", false, fmt(e));
    }

    try {
      const { error } = await sb().from("profiles")
        .upsert({ id: userId, display_name: "Parent" }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      add("Écriture du profil", true);
    } catch (e) {
      add("Écriture du profil", false, fmt(e));
    }

    try {
      const t = await myTeams();
      add("Lecture des équipes", true, t.length + " équipe(s) : " + t.map((x) => x.name).join(", "));
    } catch (e) {
      add("Lecture des équipes", false, fmt(e));
    }

    try {
      const { error } = await sb().from("matches").select("id").limit(1);
      if (error) throw error;
      add("Lecture des matchs", true);
    } catch (e) {
      add("Lecture des matchs", false, fmt(e));
    }

    return steps;
  }

  // Test d'écriture réel : c'est l'opération qui échoue chez l'utilisateur.
  async function testCreateTeam(name) {
    try {
      const team = await createTeam(name, null, null);
      return { ok: true, detail: "équipe « " + team.name + " » créée" };
    } catch (e) {
      return { ok: false, detail: fmt(e) };
    }
  }

  return {
    enabled, ready, me, diagnose, testCreateTeam, fmt,
    myTeams, createTeam, deleteTeam, joinTeam, setDisplayName,
    loadTeam, supportsOrdering, saveMatch, deleteMatch, importMatches, saveResponse, deleteResponse, setResponsePositions,
    watch, cacheRead, cacheWrite,
  };
})();
