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
        return userId;
      })();
    }
    return sessionPromise;
  }

  function me() {
    return userId;
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
      players: (row.responses || []).map((r) => ({
        id: r.id,
        profileId: r.profile_id,
        name: r.profiles ? r.profiles.display_name : "?",
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
    const { data, error } = await sb().rpc("create_team", {
      p_name: name,
      p_season: season || null,
      p_display_name: displayName || null,
    });
    if (error) throw error;
    return data;
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

  async function loadTeam(teamId, teamName) {
    await ready();
    const { data, error } = await sb()
      .from("matches")
      .select(`
        id, opponent, match_date, kickoff_time, venue, arrival_time,
        external_source, external_uid,
        meeting_points ( id, name, departure_time, players_expected, position ),
        responses ( id, profile_id, meeting_point_id, drives, seats, stays_if_unused,
                    profiles ( display_name ) )
      `)
      .eq("team_id", teamId)
      .order("match_date");
    if (error) throw error;
    return (data || []).map((row) => toAppMatch(row, teamName));
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

  // Importe des événements Kalisport sans recréer ceux déjà présents :
  // l'index unique sur (équipe, source, uid) fait foi côté base.
  async function importMatches(teamId, events) {
    await ready();
    const rows = events.map((ev) => ({
      team_id: teamId,
      opponent: ev.summary,
      match_date: ev.start.date,
      kickoff_time: ev.start.time || null,
      venue: ev.location || null,
      external_source: "kalisport",
      external_uid: ev.uid || ev.summary + ev.start.date,
    }));
    const { data, error } = await sb()
      .from("matches")
      .upsert(rows, { onConflict: "team_id,external_source,external_uid", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    return (data || []).length;
  }

  // ---------- Réponses ----------

  async function saveResponse(matchId, pointId, answer, responseId) {
    await ready();
    const payload = {
      match_id: matchId,
      meeting_point_id: pointId || null,
      drives: answer.car === "yes",
      seats: answer.car === "yes" ? Number(answer.seats) || 0 : 0,
      stays_if_unused: answer.ifUnused === "stay",
    };
    // Corriger la réponse d'un autre parent (organisateur) : on cible la
    // ligne. Sinon c'est la sienne, identifiée par (match, personne).
    const q = responseId
      ? sb().from("responses").update(payload).eq("id", responseId)
      : sb().from("responses").upsert({ ...payload, profile_id: me() }, { onConflict: "match_id,profile_id" });
    const { error } = await q;
    if (error) throw error;
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

  return {
    enabled, ready, me,
    myTeams, createTeam, joinTeam, setDisplayName,
    loadTeam, saveMatch, deleteMatch, importMatches, saveResponse,
    watch, cacheRead, cacheWrite,
  };
})();
