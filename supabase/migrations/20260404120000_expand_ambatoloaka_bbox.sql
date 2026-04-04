-- Élargit Ambatoloaka vers l’ouest pour couvrir les POI Places souvent ~48.20x
-- (ex. -13.39873, 48.20724). Les latitudes existantes du seed restent inchangées.

update public.zones
set min_lng = 48.18
where name = 'Ambatoloaka';
