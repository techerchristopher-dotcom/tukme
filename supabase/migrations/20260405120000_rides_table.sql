-- Courses (MVP) — snapshot au moment de la demande, RLS par client.
-- client_id → auth.users(id). Pas d’accès anon. Pas d’UPDATE client (chauffeur / admin = étapes ultérieures).

create type public.ride_status as enum (
  'requested',
  'accepted',
  'in_progress',
  'completed',
  'cancelled_by_client',
  'cancelled_by_driver',
  'expired'
);

comment on type public.ride_status is
  'Cycle de vie course : MVP insère surtout requested ; transitions chauffeur plus tard.';

create table public.rides (
  id uuid primary key default gen_random_uuid(),

  client_id uuid not null references auth.users (id) on delete cascade,

  /** Chauffeur assigné (nullable jusqu’à implémentation flux chauffeur). */
  driver_id uuid references auth.users (id) on delete set null,

  status public.ride_status not null default 'requested',

  pickup_lat double precision not null,
  pickup_lng double precision not null,
  pickup_label text,

  destination_lat double precision not null,
  destination_lng double precision not null,
  destination_label text not null,
  destination_place_id text,

  pickup_zone text,
  destination_zone text,

  estimated_price_ariary integer not null,
  estimated_price_eur numeric(10, 2) not null,

  /** Aligné sur le front : normal | fallback (ne pas persister loading). */
  pricing_mode text not null
    constraint rides_pricing_mode_check
      check (pricing_mode in ('normal', 'fallback')),

  estimated_distance_m integer
    constraint rides_estimated_distance_m_nonneg
      check (estimated_distance_m is null or estimated_distance_m >= 0),

  estimated_duration_s integer
    constraint rides_estimated_duration_s_nonneg
      check (estimated_duration_s is null or estimated_duration_s >= 0),

  /** Polyline encodée (Routes API), optionnelle. */
  route_polyline text,

  /** Prix définitif facturé / validé plus tard (hors estimation affichée). */
  final_price_ariary integer
    constraint rides_final_price_ariary_nonneg
      check (final_price_ariary is null or final_price_ariary >= 0),
  final_price_eur numeric(10, 2)
    constraint rides_final_price_eur_nonneg
      check (final_price_eur is null or final_price_eur >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.rides is
  'Demande de course côté client ; métriques et tarifs au snapshot de création.';

comment on column public.rides.final_price_ariary is
  'Renseigné plus tard ; distinct de estimated_price_ariary.';
comment on column public.rides.final_price_eur is
  'Renseigné plus tard ; distinct de estimated_price_eur.';

create index rides_client_id_idx on public.rides (client_id);
create index rides_status_idx on public.rides (status);
create index rides_created_at_idx on public.rides (created_at desc);
create index rides_client_created_idx on public.rides (client_id, created_at desc);
create index rides_driver_id_idx on public.rides (driver_id)
  where driver_id is not null;

create or replace function public.tg_rides_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rides_set_updated_at
  before update on public.rides
  for each row
  execute function public.tg_rides_set_updated_at();

alter table public.rides enable row level security;

-- Aucune policy pour anon : pas d’accès public aux courses.

create policy "rides_insert_own"
  on public.rides
  for insert
  to authenticated
  with check (client_id = (select auth.uid()));

create policy "rides_select_own"
  on public.rides
  for select
  to authenticated
  using (client_id = (select auth.uid()));

-- Pas de policy UPDATE / DELETE pour authenticated : évite toute modification arbitraire.
-- Annulation client, assignation chauffeur, prix final : RPC, service role ou policies dédiées plus tard.

grant usage on type public.ride_status to authenticated;
grant select, insert on table public.rides to authenticated;
