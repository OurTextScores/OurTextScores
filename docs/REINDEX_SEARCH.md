# MeiliSearch Re-indexing Guide

This guide explains how to populate the MeiliSearch index with existing works.

## When to Use

Run the re-indexing script when:
- Setting up MeiliSearch for the first time in production
- The search index becomes corrupted or out of sync
- After migrating data or restoring from a backup
- Search returns no results despite having works in the database

## Prerequisites

1. **MeiliSearch must be running**
   ```bash
   sudo docker compose ps meili
   # Should show status as "Up (healthy)"
   ```

2. **Environment variables must be set**
   ```bash
   # In your .env file:
   MEILI_HOST=http://meili:7700
   MEILI_MASTER_KEY=<your-master-key>
   ```

3. **Backend must be able to connect to MeiliSearch**
   ```bash
   curl https://api.ourtextscores.com/api/search/health
   # Should return: {"status":"healthy","isHealthy":true}
   ```

## Running the Script

### In Production (Docker)

```bash
# SSH into your VPS
ssh your-vps-user@your-vps-host

# Navigate to the project directory
cd /opt/ourtextscores

# Run the re-indexing script inside the backend container
sudo docker compose exec backend npm run reindex:search
```

### Locally (Development)

```bash
# Make sure your local environment is running
docker compose up -d

# Run the script
cd backend
npm run reindex:search
```

## What the Script Does

1. **Health Check**: Verifies MeiliSearch is configured and healthy
2. **Fetch Works**: Retrieves all works from MongoDB
3. **Transform Data**: Converts works to search documents with proper format
4. **Batch Index**: Indexes works in batches of 100 for efficiency
5. **Show Stats**: Displays index statistics after completion

## Expected Output

```
🔄 Starting MeiliSearch re-indexing...

✅ MeiliSearch is healthy

📊 Fetching all works from database...
   Found 150 works

🔨 Preparing documents for indexing...
📤 Indexing documents in MeiliSearch...
   Indexed 100/150 works
   Indexed 150/150 works

✅ Re-indexing completed successfully!

📈 Index Statistics:
   Total documents: 150
   Index size: Ready

🔍 You can now test the search:
   curl https://api.ourtextscores.com/api/search/works?q=<search-term>
```

## Troubleshooting

### Error: "MeiliSearch is not healthy or not configured"

**Cause**: Environment variables not set or MeiliSearch not running

**Solution**:
```bash
# Check if MeiliSearch is running
sudo docker compose ps meili

# Check environment variables
cat .env | grep MEILI

# Restart MeiliSearch
sudo docker compose up -d meili

# Restart backend to pick up env changes
sudo docker compose restart backend
```

### Error: "Connection refused"

**Cause**: Backend cannot reach MeiliSearch

**Solution**:
```bash
# Check Docker network
sudo docker compose exec backend ping meili

# Check MeiliSearch logs
sudo docker compose logs meili --tail=50
```

### Search Still Returns No Results

**Cause**: Index might not be ready yet

**Solution**:
```bash
# Wait a moment, then check stats
curl https://api.ourtextscores.com/api/search/stats

# Try a simple search
curl "https://api.ourtextscores.com/api/search/works?q=bach"
```

## Verifying Success

After running the re-indexing script:

1. **Check search health**:
   ```bash
   curl https://api.ourtextscores.com/api/search/health
   ```

2. **Check index stats**:
   ```bash
   curl https://api.ourtextscores.com/api/search/stats
   ```

3. **Test a search**:
   ```bash
   curl "https://api.ourtextscores.com/api/search/works?q=<known-title>"
   ```

4. **Test in the browser**:
   - Visit https://www.ourtextscores.com
   - Use the search box to search for a work you know exists
   - Results should appear as you type

## Maintenance

### Automatic Indexing

After the initial re-index, new works are automatically indexed when:
- A work is created via `POST /api/works`
- A work is updated via `POST /api/works/:workId/metadata`
- A source is added or updated (which updates the work's metadata)

### When to Re-run

You should only need to re-run this script if:
- You're setting up production for the first time
- The MeiliSearch container was recreated (losing its data)
- You notice search is missing some works that exist in the database

## Script Location

- **Script**: `backend/src/reindex-search.ts`
- **Command**: `npm run reindex:search`
