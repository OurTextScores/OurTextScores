import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { ScannerPageProvider } from './scanner-provider.contract';
import type { ScannerOtsHomrProviderService } from './scanner-ots-homr-provider.service';

const logger = new Logger('ScannerHomrTextReview');

/**
 * Give the HOMR engine the same lyric, direction and dynamic review OTS-HOMR has.
 *
 * HOMR recognises the notes; the OTS-HOMR provider's text pipeline (detectors, calibrated fusion, OCR, gate, dynamics
 * classifier) reads the text on the same page image and returns the same `text-fusion-review` artifact an OTS-HOMR scan
 * produces. The lyric review then works on a HOMR page exactly as on an OTS-HOMR one, anchoring syllables to the notes
 * HOMR found.
 *
 * Off unless SCANNER_HOMR_TEXT_REVIEW_ENABLED=1 (and the OTS-HOMR provider's fusion is configured and pinned). A failure
 * of the text side is logged and the HOMR result is returned without the artifact: the scan itself never fails for it.
 * Every other property and method of the HOMR adapter is inherited unchanged.
 */
export function withHomrTextReview<T extends ScannerPageProvider>(
  homr: T,
  review: Pick<ScannerOtsHomrProviderService, 'reviewText'>,
  config: Pick<ConfigService, 'get'>
): T {
  const wrapped = Object.create(homr) as T;
  wrapped.scanPage = async (input) => {
    const result = await homr.scanPage(input);
    if (String(config.get<string>('SCANNER_HOMR_TEXT_REVIEW_ENABLED', '')) !== '1') return result;
    try {
      const text = await review.reviewText({
        image: input.image,
        filename: input.filename,
        contentType: input.contentType,
        // A different request from the recognition call, so a different key; stable for retries of this page.
        idempotencyKey: createHash('sha256')
          .update(`${input.idempotencyKey}:text-review`)
          .digest('hex')
      });
      return {
        ...result,
        nativeArtifacts: { ...(result.nativeArtifacts || {}), 'text-fusion-review': text.artifact }
      };
    } catch (error) {
      logger.warn(
        `Text review unavailable for a HOMR page; continuing without it: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return result;
    }
  };
  return wrapped;
}
