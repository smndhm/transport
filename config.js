/* Configuration Supabase.
 *
 * Ces deux valeurs sont publiques par conception : la clé « anon » ne
 * donne accès qu'à ce que les règles RLS du schéma autorisent, et elle
 * est de toute façon visible dans le code de toute app front.
 *
 * Ne jamais mettre ici la clé « service_role » : elle contourne RLS.
 *
 * Tant que ces champs sont vides, l'app fonctionne comme avant, en
 * stockage local et partage par lien.
 */
window.TRANSPORT_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
