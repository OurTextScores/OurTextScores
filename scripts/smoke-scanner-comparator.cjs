// @ts-check
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { MongoClient, ObjectId } = require("mongodb");

const repoRoot = resolve(__dirname, "..");
const jobId =
  process.env.SCANNER_COMPARATOR_JOB_ID ||
  "d9e6d232-21d4-4495-b873-41f6310bc434";

function loadRepoEnv() {
  const raw = readFileSync(resolve(repoRoot, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2]
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
}

function localMongoUri(uri) {
  return uri
    .replace("@mongo:27017/", "@127.0.0.1:27018/")
    .replace("mongodb://mongo:27017/", "mongodb://127.0.0.1:27018/");
}

async function retainedJobOwnerEmail() {
  if (process.env.SCANNER_COMPARATOR_OWNER_EMAIL) {
    return process.env.SCANNER_COMPARATOR_OWNER_EMAIL;
  }
  loadRepoEnv();
  const uri = localMongoUri(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ourtextscores",
  );
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const db = client.db();
    const job = await db.collection("scanner_jobs").findOne({ jobId });
    if (!job?.userId) throw new Error(`Retained scanner job ${jobId} was not found`);
    const possibleIds = [job.userId];
    if (ObjectId.isValid(String(job.userId))) {
      possibleIds.push(new ObjectId(String(job.userId)));
    }
    const owner = await db.collection("users").findOne({ _id: { $in: possibleIds } });
    if (!owner?.email) throw new Error("The retained scanner job owner was not found");
    return String(owner.email);
  } finally {
    await client.close();
  }
}

async function main() {
  const ownerEmail = await retainedJobOwnerEmail();
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "playwright",
      "test",
      "-c",
      "smoke/playwright.config.cjs",
      "--project=chromium",
      "scanner-comparator.spec.cjs",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        SCANNER_COMPARATOR_SMOKE: "1",
        SCANNER_COMPARATOR_JOB_ID: jobId,
        SCANNER_COMPARATOR_OWNER_EMAIL: ownerEmail,
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
