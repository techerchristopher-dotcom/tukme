-- Les nouvelles valeurs d’enum doivent être commitées avant toute utilisation (transaction séparée).
alter type public.ride_status add value if not exists 'awaiting_payment';
alter type public.ride_status add value if not exists 'paid';
