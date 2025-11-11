#!/usr/bin/env node
/**
 * Setup git hooks for OurTextScores
 * This script is run automatically via the "prepare" npm script
 */

const fs = require('fs');
const path = require('path');

const hooksDir = path.join(__dirname, '..', '.git', 'hooks');
const prePushHook = path.join(hooksDir, 'pre-push');

// Pre-push hook content
const prePushContent = `#!/bin/sh
# Run unit tests before pushing

echo "Running unit tests before push..."

# Run both backend and frontend unit tests
npm run test:unit

# If tests fail, prevent push
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Unit tests failed. Please fix the tests before pushing."
  echo "To skip this check, use: git push --no-verify"
  exit 1
fi

echo "✅ All unit tests passed!"
exit 0
`;

try {
  // Check if .git/hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    console.log('⚠️  .git/hooks directory not found. Skipping git hooks setup.');
    process.exit(0);
  }

  // Write pre-push hook
  fs.writeFileSync(prePushHook, prePushContent, { mode: 0o755 });
  console.log('✅ Git pre-push hook installed successfully!');
  console.log('   Unit tests will run automatically before each push.');
  console.log('   To skip: git push --no-verify');
} catch (err) {
  console.error('❌ Failed to setup git hooks:', err.message);
  // Don't fail npm install if hook setup fails
  process.exit(0);
}
