#!/bin/bash
#
# OurTextScores Production Migration Script
#
# This script migrates data from local development to production:
# 1. MongoDB data → MongoDB Atlas
# 2. MinIO object storage → Cloudflare R2
# 3. Fossil repositories → Production VPS
#
# Prerequisites:
# - All production services deployed and healthy
# - MongoDB Atlas cluster accessible
# - Cloudflare R2 buckets created
# - VPS accessible via SSH
# - Required tools installed: mongodump, mongorestore, aws-cli (for S3), ssh, tar
#
# Usage:
#   ./migrate-to-production.sh [--dry-run] [--skip-mongo] [--skip-storage] [--skip-fossil]
#
# Example:
#   ./migrate-to-production.sh --dry-run  # Test without making changes
#   ./migrate-to-production.sh             # Full migration
#

set -e  # Exit on error
set -u  # Exit on undefined variable

#
# Configuration
#

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Dry run mode (default: false)
DRY_RUN=false

# Skip flags
SKIP_MONGO=false
SKIP_STORAGE=false
SKIP_FOSSIL=false

# Parse command-line arguments
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-mongo)
      SKIP_MONGO=true
      shift
      ;;
    --skip-storage)
      SKIP_STORAGE=true
      shift
      ;;
    --skip-fossil)
      SKIP_FOSSIL=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--skip-mongo] [--skip-storage] [--skip-fossil]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--dry-run] [--skip-mongo] [--skip-storage] [--skip-fossil]"
      exit 1
      ;;
  esac
done

# Temporary directory for migration files
MIGRATION_DIR="/tmp/ourtextscores-migration-$(date +%Y%m%d-%H%M%S)"

# Log file
LOG_FILE="${MIGRATION_DIR}/migration.log"

#
# Environment Variables (override with .env file or export in shell)
#

# Source environment from .env if exists
if [ -f "../.env" ]; then
  echo -e "${BLUE}Loading environment from ../.env${NC}"
  # shellcheck disable=SC1091
  source "../.env"
fi

# MongoDB
DEV_MONGO_URI="${DEV_MONGO_URI:-mongodb://localhost:27018/ourtextscores}"
PROD_MONGO_URI="${PROD_MONGO_URI:-}"

# MinIO (development)
DEV_MINIO_ENDPOINT="${DEV_MINIO_ENDPOINT:-localhost:9002}"
DEV_MINIO_ACCESS_KEY="${DEV_MINIO_ACCESS_KEY:-minioadmin}"
DEV_MINIO_SECRET_KEY="${DEV_MINIO_SECRET_KEY:-minioadmin}"

# Cloudflare R2 (production)
PROD_R2_ENDPOINT="${PROD_R2_ENDPOINT:-}"
PROD_R2_ACCESS_KEY="${PROD_R2_ACCESS_KEY:-}"
PROD_R2_SECRET_KEY="${PROD_R2_SECRET_KEY:-}"
PROD_R2_SOURCES_BUCKET="${PROD_R2_SOURCES_BUCKET:-ourtextscores-sources}"
PROD_R2_DERIVATIVES_BUCKET="${PROD_R2_DERIVATIVES_BUCKET:-ourtextscores-derivatives}"

# Fossil repositories
DEV_FOSSIL_DATA="${DEV_FOSSIL_DATA:-../fossil_data}"
PROD_VPS_HOST="${PROD_VPS_HOST:-}"
PROD_VPS_USER="${PROD_VPS_USER:-root}"
PROD_VPS_SSH_KEY="${PROD_VPS_SSH_KEY:-$HOME/.ssh/ourtextscores_vps}"
PROD_FOSSIL_PATH="${PROD_FOSSIL_PATH:-/opt/ourtextscores/volumes/fossil_data}"

#
# Helper Functions
#

log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  case "$level" in
    INFO)
      echo -e "${BLUE}[INFO]${NC} $message" | tee -a "$LOG_FILE"
      ;;
    SUCCESS)
      echo -e "${GREEN}[SUCCESS]${NC} $message" | tee -a "$LOG_FILE"
      ;;
    WARN)
      echo -e "${YELLOW}[WARN]${NC} $message" | tee -a "$LOG_FILE"
      ;;
    ERROR)
      echo -e "${RED}[ERROR]${NC} $message" | tee -a "$LOG_FILE"
      ;;
    *)
      echo -e "$message" | tee -a "$LOG_FILE"
      ;;
  esac
}

check_command() {
  local cmd="$1"
  if ! command -v "$cmd" &> /dev/null; then
    log ERROR "Required command not found: $cmd"
    log ERROR "Please install $cmd and try again"
    exit 1
  fi
}

confirm() {
  local message="$1"
  if [ "$DRY_RUN" = true ]; then
    log INFO "[DRY RUN] Would prompt: $message"
    return 0
  fi

  echo -e "${YELLOW}$message${NC}"
  read -r -p "Continue? (yes/no): " response
  case "$response" in
    [yY][eE][sS]|[yY])
      return 0
      ;;
    *)
      log WARN "Operation cancelled by user"
      exit 1
      ;;
  esac
}

execute() {
  local description="$1"
  shift
  local cmd="$*"

  if [ "$DRY_RUN" = true ]; then
    log INFO "[DRY RUN] Would execute: $cmd"
    log INFO "[DRY RUN] Description: $description"
    return 0
  else
    log INFO "Executing: $description"
    log INFO "Command: $cmd"
    if eval "$cmd"; then
      log SUCCESS "$description - completed"
      return 0
    else
      log ERROR "$description - failed"
      return 1
    fi
  fi
}

#
# Validation
#

validate_environment() {
  log INFO "Validating environment..."

  local errors=0

  # Check required commands
  log INFO "Checking required commands..."
  check_command "mongodump" || ((errors++))
  check_command "mongorestore" || ((errors++))
  check_command "aws" || ((errors++))  # AWS CLI for S3-compatible storage
  check_command "ssh" || ((errors++))
  check_command "tar" || ((errors++))

  # Check MongoDB URIs
  if [ -z "$PROD_MONGO_URI" ]; then
    log ERROR "PROD_MONGO_URI is not set"
    log ERROR "Please set it in environment or .env file"
    ((errors++))
  fi

  # Check R2 credentials
  if [ "$SKIP_STORAGE" = false ]; then
    if [ -z "$PROD_R2_ENDPOINT" ] || [ -z "$PROD_R2_ACCESS_KEY" ] || [ -z "$PROD_R2_SECRET_KEY" ]; then
      log ERROR "Cloudflare R2 credentials not set"
      log ERROR "Please set PROD_R2_ENDPOINT, PROD_R2_ACCESS_KEY, PROD_R2_SECRET_KEY"
      ((errors++))
    fi
  fi

  # Check VPS SSH access
  if [ "$SKIP_FOSSIL" = false ]; then
    if [ -z "$PROD_VPS_HOST" ]; then
      log ERROR "PROD_VPS_HOST is not set"
      ((errors++))
    fi

    if [ ! -f "$PROD_VPS_SSH_KEY" ]; then
      log ERROR "SSH key not found: $PROD_VPS_SSH_KEY"
      ((errors++))
    fi
  fi

  # Check source data exists
  if [ "$SKIP_MONGO" = false ]; then
    log INFO "Testing MongoDB connection..."
    if ! mongosh "$DEV_MONGO_URI" --quiet --eval "db.adminCommand({ping: 1})" &>/dev/null; then
      log ERROR "Cannot connect to development MongoDB: $DEV_MONGO_URI"
      log ERROR "Make sure MongoDB is running (docker compose up -d mongo)"
      ((errors++))
    else
      log SUCCESS "Development MongoDB connection OK"
    fi
  fi

  if [ "$errors" -gt 0 ]; then
    log ERROR "Validation failed with $errors error(s)"
    exit 1
  fi

  log SUCCESS "Environment validation passed"
}

#
# Migration Functions
#

migrate_mongodb() {
  log INFO "===== MongoDB Migration ====="

  if [ "$SKIP_MONGO" = true ]; then
    log WARN "Skipping MongoDB migration (--skip-mongo flag)"
    return 0
  fi

  local dump_dir="${MIGRATION_DIR}/mongodb_dump"

  # Get database name from URI
  local dev_db
  dev_db=$(echo "$DEV_MONGO_URI" | sed -n 's|.*\/\([^?]*\).*|\1|p')
  dev_db=${dev_db:-ourtextscores}

  log INFO "Source database: $dev_db"
  log INFO "Target: MongoDB Atlas"

  # Count documents to migrate
  local total_docs
  total_docs=$(mongosh "$DEV_MONGO_URI" --quiet --eval "db.works.countDocuments()" 2>/dev/null || echo "unknown")
  log INFO "Approximate documents to migrate: $total_docs works"

  confirm "⚠️  This will migrate MongoDB data to production Atlas cluster. Existing data may be overwritten."

  # Step 1: Export from development MongoDB
  log INFO "Step 1/3: Exporting from development MongoDB..."
  execute "MongoDB export" \
    "mongodump --uri='$DEV_MONGO_URI' --out='$dump_dir'"

  # Verify export
  if [ ! -d "$dump_dir/$dev_db" ]; then
    log ERROR "Export failed: directory $dump_dir/$dev_db not found"
    return 1
  fi

  local dump_size
  dump_size=$(du -sh "$dump_dir" | cut -f1)
  log SUCCESS "Export completed: $dump_size"

  # Step 2: Import to production MongoDB Atlas
  log INFO "Step 2/3: Importing to MongoDB Atlas..."
  log WARN "This will overwrite existing data in production!"

  execute "MongoDB import" \
    "mongorestore --uri='$PROD_MONGO_URI' --drop '$dump_dir'"

  # Step 3: Verify migration
  log INFO "Step 3/3: Verifying migration..."
  local prod_count
  prod_count=$(mongosh "$PROD_MONGO_URI" --quiet --eval "db.works.countDocuments()" 2>/dev/null || echo "0")
  log INFO "Production database now has: $prod_count works"

  if [ "$total_docs" != "unknown" ] && [ "$prod_count" -ne "$total_docs" ]; then
    log WARN "Document count mismatch: expected $total_docs, got $prod_count"
    log WARN "Please verify the migration manually"
  else
    log SUCCESS "MongoDB migration completed successfully"
  fi

  return 0
}

migrate_object_storage() {
  log INFO "===== Object Storage Migration ====="

  if [ "$SKIP_STORAGE" = true ]; then
    log WARN "Skipping object storage migration (--skip-storage flag)"
    return 0
  fi

  log INFO "Source: MinIO (localhost:9002)"
  log INFO "Target: Cloudflare R2"

  confirm "⚠️  This will migrate object storage (PDFs, MusicXML) to Cloudflare R2. This may take a long time for 200K works."

  # Configure AWS CLI for MinIO (development)
  export AWS_ACCESS_KEY_ID="$DEV_MINIO_ACCESS_KEY"
  export AWS_SECRET_ACCESS_KEY="$DEV_MINIO_SECRET_KEY"

  # Step 1: Sync sources bucket
  log INFO "Step 1/2: Migrating sources bucket..."
  local dev_endpoint="http://${DEV_MINIO_ENDPOINT}"

  # Count objects in source
  local sources_count
  sources_count=$(aws --endpoint-url "$dev_endpoint" s3 ls s3://scores-raw --recursive 2>/dev/null | wc -l || echo "0")
  log INFO "Found $sources_count objects in sources bucket"

  # Sync to R2
  execute "Sync sources to R2" \
    "aws --endpoint-url '$PROD_R2_ENDPOINT' \
      s3 sync s3://scores-raw s3://$PROD_R2_SOURCES_BUCKET \
      --source-endpoint-url '$dev_endpoint' \
      --source-access-key-id '$DEV_MINIO_ACCESS_KEY' \
      --source-secret-access-key '$DEV_MINIO_SECRET_KEY'"

  # Step 2: Sync derivatives bucket
  log INFO "Step 2/2: Migrating derivatives bucket..."
  local derivatives_count
  derivatives_count=$(aws --endpoint-url "$dev_endpoint" s3 ls s3://scores-derivatives --recursive 2>/dev/null | wc -l || echo "0")
  log INFO "Found $derivatives_count objects in derivatives bucket"

  execute "Sync derivatives to R2" \
    "aws --endpoint-url '$PROD_R2_ENDPOINT' \
      s3 sync s3://scores-derivatives s3://$PROD_R2_DERIVATIVES_BUCKET \
      --source-endpoint-url '$dev_endpoint' \
      --source-access-key-id '$DEV_MINIO_ACCESS_KEY' \
      --source-secret-access-key '$DEV_MINIO_SECRET_KEY'"

  # Verify
  log INFO "Verifying migration..."
  local r2_sources_count
  local r2_derivatives_count
  r2_sources_count=$(aws --endpoint-url "$PROD_R2_ENDPOINT" s3 ls s3://"$PROD_R2_SOURCES_BUCKET" --recursive 2>/dev/null | wc -l || echo "0")
  r2_derivatives_count=$(aws --endpoint-url "$PROD_R2_ENDPOINT" s3 ls s3://"$PROD_R2_DERIVATIVES_BUCKET" --recursive 2>/dev/null | wc -l || echo "0")

  log INFO "R2 sources bucket: $r2_sources_count objects"
  log INFO "R2 derivatives bucket: $r2_derivatives_count objects"

  if [ "$r2_sources_count" -eq 0 ] && [ "$sources_count" -gt 0 ]; then
    log ERROR "Sources migration may have failed (0 objects in R2)"
    return 1
  fi

  log SUCCESS "Object storage migration completed"
  return 0
}

migrate_fossil_repos() {
  log INFO "===== Fossil Repositories Migration ====="

  if [ "$SKIP_FOSSIL" = true ]; then
    log WARN "Skipping Fossil migration (--skip-fossil flag)"
    return 0
  fi

  log INFO "Source: $DEV_FOSSIL_DATA"
  log INFO "Target: $PROD_VPS_HOST:$PROD_FOSSIL_PATH"

  # Check if source exists
  if [ ! -d "$DEV_FOSSIL_DATA" ]; then
    log WARN "Fossil data directory does not exist: $DEV_FOSSIL_DATA"
    log WARN "Skipping Fossil migration"
    return 0
  fi

  # Count fossil repos
  local fossil_count
  fossil_count=$(find "$DEV_FOSSIL_DATA" -name "*.fossil" 2>/dev/null | wc -l || echo "0")
  log INFO "Found $fossil_count Fossil repositories"

  if [ "$fossil_count" -eq 0 ]; then
    log WARN "No Fossil repositories found. Skipping migration."
    return 0
  fi

  confirm "⚠️  This will upload $fossil_count Fossil repositories to the production VPS."

  # Step 1: Create tarball
  log INFO "Step 1/3: Creating tarball of Fossil repositories..."
  local tarball="${MIGRATION_DIR}/fossil_data.tar.gz"

  execute "Create Fossil tarball" \
    "tar -czf '$tarball' -C '$DEV_FOSSIL_DATA' ."

  local tarball_size
  tarball_size=$(du -sh "$tarball" | cut -f1)
  log SUCCESS "Tarball created: $tarball_size"

  # Step 2: Upload to VPS
  log INFO "Step 2/3: Uploading to VPS..."

  execute "Upload Fossil tarball" \
    "scp -i '$PROD_VPS_SSH_KEY' '$tarball' '$PROD_VPS_USER@$PROD_VPS_HOST:/tmp/fossil_data.tar.gz'"

  # Step 3: Extract on VPS
  log INFO "Step 3/3: Extracting on VPS..."

  execute "Extract Fossil data on VPS" \
    "ssh -i '$PROD_VPS_SSH_KEY' '$PROD_VPS_USER@$PROD_VPS_HOST' \
      'mkdir -p $PROD_FOSSIL_PATH && \
       tar -xzf /tmp/fossil_data.tar.gz -C $PROD_FOSSIL_PATH && \
       rm /tmp/fossil_data.tar.gz'"

  # Verify
  log INFO "Verifying migration..."
  local vps_fossil_count
  vps_fossil_count=$(ssh -i "$PROD_VPS_SSH_KEY" "$PROD_VPS_USER@$PROD_VPS_HOST" \
    "find '$PROD_FOSSIL_PATH' -name '*.fossil' 2>/dev/null | wc -l" || echo "0")

  log INFO "VPS Fossil repositories: $vps_fossil_count"

  if [ "$vps_fossil_count" -ne "$fossil_count" ]; then
    log WARN "Fossil count mismatch: expected $fossil_count, got $vps_fossil_count"
  else
    log SUCCESS "Fossil repositories migrated successfully"
  fi

  return 0
}

#
# Main
#

main() {
  echo -e "${BLUE}"
  echo "========================================="
  echo "  OurTextScores Production Migration"
  echo "========================================="
  echo -e "${NC}"

  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No changes will be made${NC}"
    echo ""
  fi

  # Create migration directory
  mkdir -p "$MIGRATION_DIR"
  log INFO "Migration directory: $MIGRATION_DIR"
  log INFO "Log file: $LOG_FILE"
  echo ""

  # Validate environment
  validate_environment
  echo ""

  # Show migration plan
  log INFO "Migration Plan:"
  if [ "$SKIP_MONGO" = false ]; then
    echo "  ✓ MongoDB: $DEV_MONGO_URI → MongoDB Atlas"
  else
    echo "  ✗ MongoDB: SKIPPED"
  fi

  if [ "$SKIP_STORAGE" = false ]; then
    echo "  ✓ Object Storage: MinIO → Cloudflare R2"
  else
    echo "  ✗ Object Storage: SKIPPED"
  fi

  if [ "$SKIP_FOSSIL" = false ]; then
    echo "  ✓ Fossil Repos: $DEV_FOSSIL_DATA → VPS"
  else
    echo "  ✗ Fossil Repos: SKIPPED"
  fi
  echo ""

  # Final confirmation
  if [ "$DRY_RUN" = false ]; then
    confirm "⚠️  WARNING: This will migrate data to PRODUCTION. Make sure you have backups!"
  fi
  echo ""

  # Start migration
  local start_time
  start_time=$(date +%s)

  log INFO "Migration started at $(date)"
  echo ""

  # Execute migrations
  if ! migrate_mongodb; then
    log ERROR "MongoDB migration failed"
    exit 1
  fi
  echo ""

  if ! migrate_object_storage; then
    log ERROR "Object storage migration failed"
    exit 1
  fi
  echo ""

  if ! migrate_fossil_repos; then
    log ERROR "Fossil migration failed"
    exit 1
  fi
  echo ""

  # Calculate duration
  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))
  local minutes=$((duration / 60))
  local seconds=$((duration % 60))

  # Summary
  echo -e "${GREEN}"
  echo "========================================="
  echo "  Migration Completed Successfully! 🎉"
  echo "========================================="
  echo -e "${NC}"

  log SUCCESS "Total time: ${minutes}m ${seconds}s"
  log SUCCESS "Migration log: $LOG_FILE"
  echo ""

  log INFO "Next steps:"
  echo "  1. Verify data in production:"
  echo "     - MongoDB Atlas: https://cloud.mongodb.com/"
  echo "     - Cloudflare R2: https://dash.cloudflare.com/"
  echo "     - Backend API: https://api.ourtextscores.com/api-docs"
  echo "  2. Test frontend: https://ourtextscores.com"
  echo "  3. Run smoke tests to verify functionality"
  echo ""

  if [ "$DRY_RUN" = true ]; then
    log WARN "This was a DRY RUN. No actual changes were made."
    log WARN "Run without --dry-run to perform the migration."
  fi
}

# Run main
main "$@"
