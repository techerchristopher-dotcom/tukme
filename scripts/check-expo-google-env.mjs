/**
 * Vérifie que .env contient une ligne EXPO_PUBLIC_GOOGLE_PLACES_API_KEY valide (hors placeholder).
 * Usage : node scripts/check-expo-google-env.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

const PLACEHOLDER = 'REPLACE_WITH_YOUR_GOOGLE_PLACES_KEY';

if (!fs.existsSync(envPath)) {
  console.error('❌ Fichier .env introuvable à la racine du projet.');
  process.exit(1);
}

const raw = fs.readFileSync(envPath, 'utf8');
const lines = raw.split(/\r?\n/);

const googleLine = lines.find((l) => {
  const t = l.trim();
  return (
    t.startsWith('EXPO_PUBLIC_GOOGLE_PLACES_API_KEY=') &&
    !t.startsWith('#')
  );
});

if (!googleLine) {
  console.error(
    '❌ Aucune ligne « EXPO_PUBLIC_GOOGLE_PLACES_API_KEY= » dans .env.'
  );
  process.exit(1);
}

const eq = googleLine.indexOf('=');
const val = googleLine.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

if (!val || val === PLACEHOLDER) {
  console.error(
    '❌ Clé absente ou encore le placeholder — remplace la valeur après le = par ta clé Google Places.'
  );
  process.exit(1);
}

if (/\s/.test(val)) {
  console.error(
    '❌ La clé contient des espaces (ou la ligne est mal formatée).'
  );
  process.exit(1);
}

console.log(
  `✅ EXPO_PUBLIC_GOOGLE_PLACES_API_KEY définie (${val.length} caractères). Relance « npx expo start » pour l’injection côté Metro.`
);
process.exit(0);
