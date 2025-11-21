import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WorksService } from './works/works.service';
import { InjectModel } from '@nestjs/mongoose';
import { SourceRevision, SourceRevisionDocument } from './works/schemas/source-revision.schema';
import { Source, SourceDocument } from './works/schemas/source.schema';
import { Model } from 'mongoose';
import { StorageService } from './storage/storage.service';
import { DerivativePipelineService } from './works/derivative-pipeline.service';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const logger = new Logger('ThumbnailBackfill');

    const sourceRevisionModel = app.get<Model<SourceRevisionDocument>>('SourceRevisionModel');
    const sourceModel = app.get<Model<SourceDocument>>('SourceModel');
    const storageService = app.get(StorageService);
    const derivativePipelineService = app.get(DerivativePipelineService);
    // We need to access the private generateThumbnail method or expose it. 
    // Since it's private, we'll duplicate the logic here for the script to avoid changing the service public API just for this.
    // Alternatively, we could make it public. Let's duplicate for safety and standalone execution.

    logger.log('Starting thumbnail backfill...');

    const revisions = await sourceRevisionModel.find({
        'derivatives.pdf': { $exists: true },
        'derivatives.thumbnail': { $exists: false }
    });

    logger.log(`Found ${revisions.length} revisions needing thumbnails.`);

    for (const rev of revisions) {
        logger.log(`Processing revision ${rev.revisionId} (Work: ${rev.workId}, Source: ${rev.sourceId})`);

        try {
            const pdfLocator = rev.derivatives?.pdf;
            if (!pdfLocator) continue;

            const pdfBuffer = await storageService.getObjectBuffer(pdfLocator.bucket, pdfLocator.objectKey);

            // Generate thumbnail
            const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-thumb-'));
            let thumbBuffer: Buffer | undefined;

            try {
                thumbBuffer = await derivativePipelineService.generateThumbnail(pdfBuffer, workspace);
            } finally {
                await fs.rm(workspace, { recursive: true, force: true });
            }

            if (!thumbBuffer) {
                logger.warn(`Failed to generate thumbnail for ${rev.revisionId}`);
                continue;
            }

            // Store thumbnail
            const derivativesBaseKey = `${rev.workId}/${rev.sourceId}/rev-${rev.sequenceNumber.toString().padStart(4, '0')}`;
            const thumbKey = `${derivativesBaseKey}/thumbnail.png`;

            // We need to replicate storage logic or use storage service public API
            // StorageService.putDerivativeObject is public
            const result = await storageService.putDerivativeObject(
                thumbKey,
                thumbBuffer,
                thumbBuffer.length,
                'image/png'
            );

            const thumbnailLocator = {
                bucket: result.bucket,
                objectKey: result.objectKey,
                sizeBytes: thumbBuffer.length,
                checksum: {
                    algorithm: 'sha256',
                    hexDigest: require('crypto').createHash('sha256').update(thumbBuffer).digest('hex')
                },
                contentType: 'image/png',
                lastModifiedAt: new Date()
            };

            // Update Revision
            await sourceRevisionModel.updateOne(
                { _id: rev._id },
                { $set: { 'derivatives.thumbnail': thumbnailLocator } }
            );

            // Update Source if latest
            const source = await sourceModel.findOne({ workId: rev.workId, sourceId: rev.sourceId });
            if (source && source.latestRevisionId === rev.revisionId) {
                await sourceModel.updateOne(
                    { _id: source._id },
                    { $set: { 'derivatives.thumbnail': thumbnailLocator } }
                );
            }

            logger.log(`Generated thumbnail for ${rev.revisionId}`);

        } catch (err) {
            logger.error(`Failed to process ${rev.revisionId}: ${err}`);
        }
    }

    logger.log('Backfill complete.');
    await app.close();
}

bootstrap();
