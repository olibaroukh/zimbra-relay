# zimbra-relay
## Déploiement

Depuis le 05/11/2026, zimbra-relay est déployé **automatiquement par Cloudflare** (Workers Builds) à chaque fusion sur `main` : plus de copier-coller du code dans le tableau de bord. Les réglages (liaisons, tâches planifiées, date de compatibilité) sont décrits dans `wrangler.toml` ; les variables et secrets restent saisis dans Cloudflare (`keep_vars = true`).

En cas de problème après un déploiement : Cloudflare › zimbra-relay › Déploiements › « … » sur la version précédente › **Restaurer** (retour arrière immédiat).
