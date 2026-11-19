# PokéMarges

Suivi de revente Pokémon — cartes, gradées et scellés — avec capital investi,
marge latente, marge réalisée et journal des ventes.

Site statique sur GitHub Pages, données dans Supabase.

## Mise en route

1. **Créer un projet Supabase** (gratuit) sur [supabase.com](https://supabase.com).
2. Dans **SQL Editor**, coller le contenu de [`schema.sql`](schema.sql) et lancer.
3. Dans **Project Settings → API**, copier *Project URL* et la clé *anon public*,
   puis les coller dans [`config.js`](config.js).
4. Dans **Authentication → Providers**, vérifier que *Email* est activé.
5. Pousser sur GitHub, activer **Settings → Pages → Deploy from branch → main**.

## D'où viennent les valeurs

| Catégorie | Source | Nature |
|---|---|---|
| Cartes | Tendance Cardmarket via [TCGdex](https://tcgdex.dev), lue en direct dans le navigateur | ventes réelles |
| Scellés | Médiane des annonces Vinted comparables, calculée sur le Mac | **prix demandés** |
| Gradées | Saisie manuelle | — |

Une valeur saisie à la main prime toujours sur l'estimation automatique.

> Les champs `-holo` de l'API TCGdex ne sont pas la cote d'une carte holographique :
> ils désignent une autre référence Cardmarket et sont incohérents (Dracaufeu Set
> de Base : `trend` 441,68 € contre `trend-holo` 123,63 €). Seuls les champs de
> base sont utilisés.

## Vie privée

L'adresse du site est publique, les données ne le sont pas. La clé `anon` publiée
dans `config.js` ne donne accès à rien : chaque table est protégée par Row Level
Security (`auth.uid() = user_id`). La connexion se fait par lien magique envoyé
par e-mail, sans mot de passe.

## Fichiers

```
index.html      structure et styles
app.js          logique
config.js       URL et clé publique Supabase
schema.sql      tables et règles de sécurité
cards-fr.json   index des 22 342 cartes françaises
```

`cards-fr.json` se régénère avec `build_card_index.py` (dans le projet du bot).
