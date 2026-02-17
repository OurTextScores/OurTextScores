#!/usr/bin/env node
/* eslint-disable no-console */
const mongoose = require('mongoose');

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--')) continue;
    const idx = entry.indexOf('=');
    if (idx === -1) {
      args[entry.slice(2)] = 'true';
    } else {
      args[entry.slice(2, idx)] = entry.slice(idx + 1);
    }
  }
  return args;
}

function clean(input) {
  const value = String(input ?? '').trim();
  return value.length ? value : undefined;
}

function normalizeEmail(input) {
  const value = clean(input);
  return value ? value.toLowerCase() : undefined;
}

function parseRoles(input) {
  const value = clean(input) || 'user,admin';
  const roles = value
    .split(/[,\s]+/)
    .map((role) => role.trim())
    .filter(Boolean);
  if (!roles.includes('user')) roles.unshift('user');
  return Array.from(new Set(roles));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mongoUri = clean(args['mongo-uri']) || clean(process.env.MONGO_URI);
  if (!mongoUri) {
    throw new Error('MONGO_URI is required (or pass --mongo-uri)');
  }

  const email = normalizeEmail(args.email);
  if (!email) {
    throw new Error('--email is required');
  }

  const roles = parseRoles(args.roles);
  const displayName = clean(args['display-name']);
  const now = new Date();

  await mongoose.connect(mongoUri);
  const users = mongoose.connection.db.collection('users');

  const update = {
    $set: {
      email,
      updatedAt: now
    },
    $setOnInsert: {
      createdAt: now,
      status: 'active',
      enforcementStrikes: 0,
      notify: { watchPreference: 'immediate' }
    },
    $addToSet: {
      roles: { $each: roles }
    }
  };

  if (displayName) {
    update.$set.displayName = displayName;
  }

  const result = await users.updateOne({ email }, update, { upsert: true });
  const user = await users.findOne(
    { email },
    {
      projection: {
        _id: 1,
        email: 1,
        displayName: 1,
        roles: 1,
        status: 1,
        enforcementStrikes: 1,
        createdAt: 1,
        updatedAt: 1
      }
    }
  );

  console.log('[seed-admin-user] upsertedId=', result.upsertedId ? String(result.upsertedId) : 'none');
  console.log('[seed-admin-user] matchedCount=', result.matchedCount, 'modifiedCount=', result.modifiedCount);
  console.log('[seed-admin-user] user=', JSON.stringify(user, null, 2));
}

main()
  .catch((error) => {
    console.error('[seed-admin-user] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
  });
