-- Publication Realtime pour les mises à jour `rides` (postgres_changes côté client).
-- Pas de REPLICA IDENTITY FULL : le MVP n’a besoin que du nouvel enregistrement sur UPDATE.

do $body$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rides'
  ) then
    alter publication supabase_realtime add table public.rides;
  end if;
end
$body$;

