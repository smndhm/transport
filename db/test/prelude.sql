-- Simulacre minimal de l'environnement Supabase pour valider le schéma.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema extensions;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
