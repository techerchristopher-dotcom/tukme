-- Nouvelles valeurs enum (transaction séparée avant utilisation dans la migration suivante).
alter type public.ride_status add value if not exists 'en_route';
alter type public.ride_status add value if not exists 'arrived';
