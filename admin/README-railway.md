## Déploiement Railway — Tukme Admin (Next.js)

### Root Directory
- `admin`

### Build command
```bash
npm ci && npm run build
```

### Start command
```bash
npm run start
```

### Variables d’environnement (Railway)
Renseigner exactement ces variables :
- `NEXT_PUBLIC_SUPABASE_URL` = `https://xxxx.supabase.co`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `eyJ...` (anon JWT) ou `sb_publishable_...`

### Healthcheck
- Path: `/api/health`
- Attendu: HTTP 200, body JSON `{ "ok": true }`

