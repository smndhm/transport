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
  supabaseUrl: "https://nfucxwoylzvztqdifldo.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mdWN4d295bHp2enRxZGlmbGRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNDQyNjcsImV4cCI6MjEwNDcyMDI2N30.oCgShUyt9afd-vTsB9p32669GrcHyA39fqdjzGrU420",
};
