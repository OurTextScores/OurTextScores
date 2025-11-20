# Production Setup for MeiliSearch

This document guides you through setting up MeiliSearch in production to enable search functionality.

## Quick Start (Production)

Follow these steps on your VPS to enable search:

### 1. Add MeiliSearch Environment Variables

```bash
# SSH into your VPS
ssh your-vps

# Edit .env file
cd /opt/ourtextscores
nano .env
```

Add these lines (generate a unique random key):
```env
MEILI_HOST=http://meili:7700
MEILI_MASTER_KEY=<paste-random-key-here>
```

To generate a random key:
```bash
openssl rand -base64 32
```

### 2. Pull Latest Code and Rebuild

```bash
# Pull latest changes (includes reindex script)
git pull

# Rebuild and restart services
sudo docker compose up -d --build backend meili
```

### 3. Verify MeiliSearch is Running

```bash
# Check service status
sudo docker compose ps meili

# Check health endpoint
curl https://api.ourtextscores.com/api/search/health
# Should return: {"status":"healthy","isHealthy":true}
```

### 4. Re-index Existing Works

```bash
# Run the reindex script
sudo docker compose exec backend npm run reindex:search
```

Expected output:
```
✅ MeiliSearch is healthy
📊 Fetching all works from database...
   Found XXX works
📤 Indexing documents in MeiliSearch...
   Indexed XXX/XXX works
✅ Re-indexing completed successfully!
```

### 5. Test Search

```bash
# Test via API
curl "https://api.ourtextscores.com/api/search/works?q=bach"

# Or test in browser
# Visit https://www.ourtextscores.com and use the search box
```

## Troubleshooting

### Health check returns "not_configured"

**Cause**: Environment variables not set or backend not restarted

**Solution**:
```bash
# Verify env vars are in .env
cat .env | grep MEILI

# Restart backend to pick up changes
sudo docker compose restart backend

# Check logs
sudo docker compose logs backend --tail=50 | grep -i meili
```

###  Re-index fails with connection error

**Cause**: MeiliSearch container not running

**Solution**:
```bash
# Start MeiliSearch
sudo docker compose up -d meili

# Check logs
sudo docker compose logs meili --tail=50

# Restart backend
sudo docker compose restart backend
```

### Search returns no results

**Cause**: Index is empty

**Solution**:
```bash
# Check index stats
curl https://api.ourtextscores.com/api/search/stats

# If numberOfDocuments is 0, run reindex
sudo docker compose exec backend npm run reindex:search
```

## Local Testing

The script was tested locally and successfully indexed 177 works:

```bash
# Local test (with Docker running)
docker compose exec backend npm run reindex:search

# Test search
curl "http://localhost:4000/api/search/works?q=bach"
```

## What's Next

After setting up MeiliSearch:
1. Search will work on the homepage
2. New works will be auto-indexed when created/updated
3. Re-indexing is only needed if:
   - MeiliSearch container is recreated
   - Index becomes corrupted
   - After bulk data imports

See [REINDEX_SEARCH.md](./REINDEX_SEARCH.md) for detailed documentation.
