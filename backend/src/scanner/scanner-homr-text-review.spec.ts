import { withHomrTextReview } from './scanner-homr-text-review';

describe('withHomrTextReview', () => {
  const values: Record<string, string> = {};
  const config = { get: (key: string, fallback?: string) => values[key] ?? fallback } as any;
  const input = {
    image: Buffer.from('page'),
    filename: 'page.png',
    contentType: 'image/png',
    detectTitle: false,
    idempotencyKey: 'a'.repeat(64),
    engineOptions: { textReview: true }
  };
  const homrResult = {
    engine: 'homr',
    musicXml: Buffer.from('<score-partwise/>'),
    nativeArtifacts: { other: Buffer.from('keep') }
  } as any;
  const makeHomr = () =>
    ({
      engine: 'homr',
      expectedRevision: 'rev',
      createIdempotencyKey: jest.fn(() => 'key'),
      regenerateReview: jest.fn(),
      scanPage: jest.fn(async () => homrResult)
    }) as any;

  beforeEach(() => {
    delete values.SCANNER_HOMR_TEXT_REVIEW_ENABLED;
  });

  it('does nothing unless it is switched on', async () => {
    const homr = makeHomr();
    const review = { reviewText: jest.fn() };
    const result = await withHomrTextReview(homr, review, config).scanPage(input);
    expect(result).toBe(homrResult);
    expect(review.reviewText).not.toHaveBeenCalled();
  });

  it('does nothing for a job that did not ask for it', async () => {
    values.SCANNER_HOMR_TEXT_REVIEW_ENABLED = '1';
    const review = { reviewText: jest.fn() };
    const result = await withHomrTextReview(makeHomr(), review, config).scanPage({
      ...input,
      engineOptions: undefined
    });
    expect(result).toBe(homrResult);
    expect(review.reviewText).not.toHaveBeenCalled();
  });

  it('attaches the text review of the same page, under its own idempotency key, and keeps the HOMR result', async () => {
    values.SCANNER_HOMR_TEXT_REVIEW_ENABLED = '1';
    const homr = makeHomr();
    const artifact = Buffer.from('{"fusionSummary":{}}');
    const review = { reviewText: jest.fn(async () => ({ artifact, providerRevision: 'v11' })) };
    const result = await withHomrTextReview(homr, review, config).scanPage(input);
    expect(review.reviewText).toHaveBeenCalledWith(
      expect.objectContaining({
        image: input.image,
        filename: 'page.png',
        contentType: 'image/png'
      })
    );
    const key = (review.reviewText as jest.Mock).mock.calls[0][0].idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(input.idempotencyKey);
    expect(result.musicXml).toBe(homrResult.musicXml);
    expect(result.nativeArtifacts).toEqual({
      other: Buffer.from('keep'),
      'text-fusion-review': artifact
    });
    // The original result object is not mutated.
    expect(homrResult.nativeArtifacts['text-fusion-review']).toBeUndefined();
  });

  it('never fails the HOMR scan because the text side failed', async () => {
    values.SCANNER_HOMR_TEXT_REVIEW_ENABLED = '1';
    const review = { reviewText: jest.fn(async () => Promise.reject(new Error('provider down'))) };
    const result = await withHomrTextReview(makeHomr(), review, config).scanPage(input);
    expect(result).toBe(homrResult);
  });

  it('leaves everything else of the HOMR adapter in place', () => {
    const wrapped = withHomrTextReview(makeHomr(), { reviewText: jest.fn() }, config);
    expect(wrapped.engine).toBe('homr');
    expect(wrapped.expectedRevision).toBe('rev');
    expect(wrapped.createIdempotencyKey({} as any)).toBe('key');
    expect(typeof wrapped.regenerateReview).toBe('function');
  });
});
