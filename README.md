# AATM Web API — NAS Edition

> ⚠️ Dans cet environnement, l'accès GitHub au dépôt upstream `loteran/aatm-web-api` est bloqué (`403`). Cette édition livre une base NAS complète orientée workflow AATM (browse → mediainfo → torrent+nfo → upload trackers/clients) avec adaptation qBittorrent distant **category-only**.

## Fonctionnalités livrées

1. UI web moderne dark mode
2. Explorateur de fichiers NAS (navigation dossiers/fichiers)
3. Analyse MediaInfo côté serveur (`mediainfo --Output=JSON`)
4. Création `.torrent` avec progression temps réel (SSE)
5. Génération NFO automatique
6. Organisation output NAS:
   - `{outputDir}/Films/{nom}/`
   - `{outputDir}/Séries/{nom}/`
   - `{outputDir}/Ebooks/{nom}/`
   - `{outputDir}/Jeux/{nom}/`
7. Upload clients torrent:
   - qBittorrent distant (principal): `/api/v2/auth/login` + `/api/v2/torrents/add`
     - `category=<cat>`
     - `autoTMM=true`
     - `skip_checking=false`
     - **sans `savepath`**
   - Transmission (optionnel)
   - Deluge (optionnel)
8. Upload La-Cale (API + preview catégorie/tags)
9. Configuration complète via UI (JSON éditable)
10. Historique des opérations (JSON dans `data/history.json`)

## Sécurité minimale

- Validation de chemins via `browseRoots` autorisés (anti-traversal)
- Validation extension `.torrent` pour push qBittorrent
- Secrets masqués dans la réponse `/api/config`
- Logs sans affichage des tokens/passwords

## API principale

- `GET /api/browse?path=...`
- `POST /api/mediainfo` `{ path }`
- `POST /api/torrent/create` `{ path, mediaType }`
- `GET /api/torrent/progress?jobId=...` (SSE)
- `GET /api/qbit/categories`
- `POST /api/torrent/push` `{ torrentPath, category, tags? }`
- `POST /api/lacale/upload`
- `POST /api/transmission/push`
- `POST /api/deluge/push`
- `GET /api/config`, `POST /api/config`
- `GET /api/history`

## Configuration NAS

Au premier démarrage, `data/config.json` est auto-créé. Configurez notamment:

- `outputDir`
- `browseRoots`
- `torrent.pieceSize/privateFlag/announce/source`
- `qbit.url/username/password/insecureTls/defaultCategory/defaultTags`
- `lacale.apiUrl/token`

## Lancement local

```bash
cp .env.example .env
node server.js
```

## Docker (NAS)

```bash
docker compose up -d --build
```

`docker-compose.yml` monte:
- `/mnt/nas/media:/nas/media`
- `/mnt/nas/output:/nas/output`
- `./data:/app/data`

## Smoke test manuel (checklist)

1. Ouvrir UI, brows­er un fichier vidéo NAS.
2. Cliquer **Analyser** (MediaInfo visible).
3. Cliquer **Créer .torrent + NFO** et vérifier progression SSE.
4. Vérifier fichiers dans output organisé (`Films/Séries/...`).
5. Charger catégories qBittorrent.
6. Envoyer vers seedbox → succès qbit sans `savepath`.
7. Tester upload La-Cale depuis la section dédiée.
8. Vérifier entrée dans Historique.

## Notes dépendances outils

L'image Docker installe `mediainfo` et `mktorrent`. Si vous exécutez hors Docker, installez-les sur l'hôte NAS.
