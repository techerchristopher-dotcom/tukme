# Tukme

Application mobile **React Native** avec **Expo** et **TypeScript**, orientée **Android** en premier. La structure sous `src/` est prête pour faire évoluer les écrans et brancher **Supabase** plus tard (sans dépendance installée pour l’instant).

## Prérequis

- Node.js (LTS recommandé)
- npm
- Pour lancer sur un appareil ou émulateur Android : [Android Studio](https://developer.android.com/studio) (SDK + émulateur) ou un téléphone avec l’app **Expo Go**

## Installation

```bash
npm install
```

Copier les variables d’environnement (optionnel tant que Supabase n’est pas branché) :

```bash
cp .env.example .env
```

## Scripts

| Commande               | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `npm start`            | Démarre le serveur de développement Expo (Metro) |
| `npm run android`      | Ouvre sur Android (émulateur ou appareil)        |
| `npm run ios`          | Ouvre sur iOS (macOS + Xcode)                    |
| `npm run web`          | Ouvre la version web                             |
| `npm run lint`         | ESLint                                           |
| `npm run format`       | Prettier (écriture)                              |
| `npm run format:check` | Prettier (vérification sans écrire)              |

## Structure

```
src/
  components/   # Composants réutilisables
  constants/    # Constantes (nom d’app, etc.)
  lib/          # Clients et utilitaires (ex. Supabase plus tard)
  screens/      # Écrans
```

Le point d’entrée UI reste `App.tsx` à la racine (convention Expo) ; il peut importer les écrans depuis `src/screens/`.

## Supabase (plus tard)

Les clés prévues sont documentées dans `.env.example`. Avec Expo, utiliser le préfixe **`EXPO_PUBLIC_`** pour les variables nécessaires côté client. Ne pas commiter le fichier `.env` (déjà ignoré par Git).

## Licence

Projet privé (`private: true` dans `package.json`).
