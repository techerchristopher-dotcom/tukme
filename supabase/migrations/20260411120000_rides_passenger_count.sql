-- MVP passagers : stockage du nombre de passagers et cohérence avec le tarif total.
-- Les lignes existantes reçoivent 1 via DEFAULT ; aucune donnée n'est supprimée.

alter table public.rides
  add column if not exists passenger_count integer not null default 1;

alter table public.rides
  drop constraint if exists rides_passenger_count_mvp_check;

alter table public.rides
  add constraint rides_passenger_count_mvp_check
  check (passenger_count >= 1 and passenger_count <= 4);

comment on column public.rides.passenger_count is
  'MVP : 1–4 passagers. Tarif total en base = tarif zone pour 1 passager × passenger_count.';
