-- Zones géographiques dynamiques (Nosy Be) + tarifs par paire
-- match_priority : plus petit = évalué en premier (zones précises avant les grandes)

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lng double precision not null,
  max_lng double precision not null,
  match_priority integer not null default 100,
  created_at timestamptz not null default now(),
  constraint zones_lat_bounds check (min_lat <= max_lat),
  constraint zones_lng_bounds check (min_lng <= max_lng)
);

create table public.zone_pricing (
  id uuid primary key default gen_random_uuid(),
  from_zone text not null references public.zones (name) on update cascade on delete cascade,
  to_zone text not null references public.zones (name) on update cascade on delete cascade,
  price_eur numeric(10, 2) not null,
  price_ariary integer not null check (price_ariary >= 0),
  created_at timestamptz not null default now(),
  unique (from_zone, to_zone)
);

create index zone_pricing_from_to_idx on public.zone_pricing (from_zone, to_zone);

alter table public.zones enable row level security;
alter table public.zone_pricing enable row level security;

create policy "zones_select_anon"
  on public.zones for select
  to anon, authenticated
  using (true);

create policy "zone_pricing_select_anon"
  on public.zone_pricing for select
  to anon, authenticated
  using (true);

insert into public.zones (name, min_lat, max_lat, min_lng, max_lng, match_priority) values
  ('Fascene', -13.325, -13.298, 48.302, 48.328, 1),
  ('Ambatoloaka', -13.432, -13.396, 48.265, 48.302, 10),
  ('Madirokely', -13.445, -13.404, 48.248, 48.288, 15),
  ('Dar es Salam', -13.428, -13.402, 48.238, 48.268, 20),
  ('Hell-Ville', -13.418, -13.388, 48.248, 48.282, 30),
  ('Dzamandzar', -13.402, -13.368, 48.248, 48.288, 40),
  ('Andilana', -13.385, -13.338, 48.208, 48.258, 50),
  ('Befotaka', -13.515, -13.438, 48.225, 48.298, 60);

insert into public.zone_pricing (from_zone, to_zone, price_eur, price_ariary) values
  ('Ambatoloaka', 'Ambatoloaka', 1.00, 5000),
  ('Ambatoloaka', 'Dar es Salam', 1.00, 5000),
  ('Ambatoloaka', 'Hell-Ville', 2.00, 10000),
  ('Dar es Salam', 'Ambatoloaka', 1.00, 5000),
  ('Hell-Ville', 'Andilana', 3.00, 15000),
  ('Hell-Ville', 'Ambatoloaka', 2.00, 10000),
  ('Hell-Ville', 'Hell-Ville', 1.00, 5000),
  ('Andilana', 'Hell-Ville', 3.00, 15000),
  ('Fascene', 'Hell-Ville', 2.50, 12500),
  ('Hell-Ville', 'Fascene', 2.50, 12500),
  ('Madirokely', 'Ambatoloaka', 1.00, 5000),
  ('Ambatoloaka', 'Madirokely', 1.00, 5000),
  ('Befotaka', 'Hell-Ville', 3.00, 15000),
  ('Dzamandzar', 'Hell-Ville', 2.00, 10000);
