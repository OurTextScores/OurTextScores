// Runs inside the local API container. Creates isolated test owners/jobs and
// shares immutable recognition inputs; never edits or deletes the source scan.
const { MongoClient, ObjectId, BSON } = require("mongodb");
const { ConfigService } = require("@nestjs/config");
const { storageServiceFromConfig } = require("./dist/storage/storage.module");
const {
  scannerEngineArtifactLocators,
} = require("./dist/scanner/scanner-dual-engine");
const {
  loadReviewSnapshot,
} = require("./dist/scanner/scanner-review-checkpoint-storage");
const { scannerUserHash } = require("./dist/scanner/scanner.constants");

(async () => {
  const [operation, encoded] = process.argv.slice(2);
  const options = JSON.parse(encoded);
  const client = await MongoClient.connect(process.env.MONGO_URI);
  try {
    const db = client.db();
    if (operation === "seed") {
      const source = await db
        .collection("scanner_jobs")
        .findOne({ jobId: options.sourceJobId });
      if (!source) throw new Error("Completed source scanner job not found");
      let sourcePage = source.pages.find(
        (page) =>
          page.included !== false &&
          page.status === "succeeded" &&
          page.engines?.["ots-homr"]?.status === "succeeded" &&
          Object.values(page.engines).filter(
            (run) => run?.status === "succeeded",
          ).length > 1,
      );
      if (!sourcePage)
        throw new Error(
          "The source must have a completed OTS-HOMR page and a second engine",
        );
      const sourceStorage = storageServiceFromConfig(
        new ConfigService(process.env),
      );
      // The owner may have advanced into a merge since the previous test run.
      // Seed from the immutable original base checkpoint, whose questions and
      // native proposal still describe the same capture.
      const original = sourcePage.reviewWorkflow?.steps?.base?.original;
      if (original) {
        sourcePage = {
          ...sourcePage,
          ...(await loadReviewSnapshot(original, (locator) =>
            sourceStorage.getObjectBuffer(locator.bucket, locator.objectKey),
          )),
        };
      }
      const expectedRevision =
        process.env.SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION;
      if (
        expectedRevision &&
        sourcePage.engines["ots-homr"].providerRevision !== expectedRevision
      ) {
        throw new Error(
          "Choose a current retained scan; this source would trigger provider compatibility recovery",
        );
      }
      const proposalLocator =
        sourcePage.engines["ots-homr"].artifacts["structured-heads"];
      const proposal = JSON.parse(
        (
          await sourceStorage.getObjectBuffer(
            proposalLocator.bucket,
            proposalLocator.objectKey,
          )
        ).toString("utf8"),
      );
      if (
        !Array.isArray(proposal.staves) ||
        !proposal.staves.length ||
        !proposal.staves.every(Array.isArray)
      ) {
        throw new Error(
          "The source must retain non-empty voice proposals so tests never rerun recognition",
        );
      }
      const owner = new ObjectId();
      await db.collection("users").insertOne({
        _id: owner,
        email: options.email,
        roles: ["user"],
        status: "active",
        enforcementStrikes: 0,
      });
      const fixture = structuredClone(source);
      Object.assign(fixture, {
        _id: new ObjectId(),
        jobId: options.jobId,
        userId: String(owner),
        originalFilename: "Playwright guided review fixture",
        status: "succeeded",
        statusVersion: 1,
        pageCount: source.pageCount,
        pages: [structuredClone(sourcePage)],
        e2eScannerReview: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        sourceExpiresAt: new Date(Date.now() + 86400000),
        resultExpiresAt: new Date(Date.now() + 86400000),
      });
      for (const key of [
        "reassembleRequestedAt",
        "leaseOwner",
        "leaseExpiresAt",
        "errorCode",
        "errorMessage",
        "retryPageNumbers",
        "sourceDeletedAt",
        "resultsDeletedAt",
      ])
        delete fixture[key];
      fixture.terminalNotifiedAt = new Date();
      const page = fixture.pages[0];
      page.ordinal = 1;
      delete page.reviewWorkflow;
      delete page.mergedMusicXml;
      delete page.mergedScore;
      // Retained legacy captures are the regression case: the API used to
      // drop these mappings even though its immutable proposal kept the tokens.
      for (const staff of page.engines["ots-homr"].review?.staves || []) {
        for (const symbol of staff.symbols || []) {
          delete symbol.proposalVoiceIndex;
          delete symbol.proposalSymbolIndex;
        }
      }
      await db.collection("scanner_jobs").insertOne(fixture);
      console.log(
        JSON.stringify({
          jobId: fixture.jobId,
          pageNumber: page.pageNumber,
          candidateEngine: Object.keys(page.engines).find(
            (id) =>
              id !== "ots-homr" && page.engines[id]?.status === "succeeded",
          ),
          bsonBytes: BSON.calculateObjectSize(fixture),
        }),
      );
    } else if (operation === "inspect") {
      const job = await db
        .collection("scanner_jobs")
        .findOne({ jobId: options.jobId, e2eScannerReview: true });
      if (!job) throw new Error("Test job not found");
      const page = job.pages[0];
      console.log(
        JSON.stringify({
          settled:
            job.status === "succeeded" &&
            !job.reassembleRequestedAt &&
            !job.leaseOwner,
          bsonBytes: BSON.calculateObjectSize(job),
          active: page.reviewWorkflow?.active,
          compact: Object.values(page.reviewWorkflow?.steps || {}).every(
            (step) =>
              !!step.snapshot.checkpointStorage && !step.snapshot.engines,
          ),
          workflowBytes: page.reviewWorkflow
            ? BSON.calculateObjectSize(page.reviewWorkflow)
            : 0,
        }),
      );
    } else if (operation === "cleanup") {
      const job = await db
        .collection("scanner_jobs")
        .findOne({ jobId: options.jobId, e2eScannerReview: true });
      if (!job) return;
      const storage = storageServiceFromConfig(new ConfigService(process.env));
      const objects = [
        ...scannerEngineArtifactLocators(job.pages[0]),
        ...job.pages.flatMap((page) => [
          page.musicXml,
          page.reviewedMusicXml,
          page.mergedMusicXml,
          page.pdf,
        ]),
        job.musicXmlBundle,
        job.combinedMusicXml,
        job.combinedPdf,
        job.resultsZip,
        job.previewPdf,
        job.previewThumbnail,
      ];
      const unique = new Map(
        objects
          .filter((locator) => locator?.objectKey?.includes(`/${job.jobId}/`))
          .map((locator) => [
            `${locator.bucket}/${locator.objectKey}`,
            locator,
          ]),
      );
      await Promise.all(
        [...unique.values()].map((locator) =>
          storage.deleteObject(locator.bucket, locator.objectKey),
        ),
      );
      const userHash = scannerUserHash(
        job.userId,
        process.env.SCANNER_OBJECT_KEY_SALT || "",
      );
      await db.collection("scanner_corrections").deleteMany({ userHash });
      await db.collection("scanner_merge_decisions").deleteMany({ userHash });
      await db
        .collection("scanner_jobs")
        .deleteOne({ _id: job._id, e2eScannerReview: true });
      await db
        .collection("users")
        .deleteOne({ _id: new ObjectId(job.userId), email: options.email });
      console.log(
        JSON.stringify({
          removedTestJob: job.jobId,
          removedTestObjects: unique.size,
        }),
      );
    } else throw new Error("Unknown test fixture operation");
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
