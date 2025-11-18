#!/usr/bin/env node
/**
 * One-time migration script to rename "main" branches to "trunk"
 * This aligns the database branch names with Fossil VCS's default branch name.
 *
 * Usage: node scripts/migrate-main-to-trunk.js
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://mongo:27017/ourtextscores';

async function migrate() {
  try {
    console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const branchesCollection = db.collection('branches');

    // Find all "main" branches
    const mainBranches = await branchesCollection.find({ name: 'main' }).toArray();
    console.log(`Found ${mainBranches.length} "main" branches to migrate`);

    if (mainBranches.length === 0) {
      console.log('No migration needed - no "main" branches found');
      await mongoose.connection.close();
      return;
    }

    // Update each "main" branch to "trunk"
    const result = await branchesCollection.updateMany(
      { name: 'main' },
      { $set: { name: 'trunk' } }
    );

    console.log(`Migration complete!`);
    console.log(`  - Modified ${result.modifiedCount} branches`);
    console.log(`  - Matched ${result.matchedCount} documents`);

    await mongoose.connection.close();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
