cat > README.md << 'EOF'
# Kindle Backend - Strava du Livre

Backend API pour scraper les données Kindle.

## Déploiement Railway

1. Pusher ce repo sur GitHub
2. Connecter Railway au repo
3. Déployer automatiquement

## API Endpoints

- GET `/api/health` - Health check
- POST `/api/sync` - Synchroniser Kindle
- GET `/api/books` - Liste des livres
- GET `/api/stats` - Statistiques
EOF