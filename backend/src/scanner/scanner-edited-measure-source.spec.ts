import { BadRequestException } from '@nestjs/common';

import { ScannerController } from './scanner.controller';

/**
 * The wire, not the logic.
 *
 * `parseEditedMeasures` rebuilds each entry field by field, so anything it does not name
 * is dropped in silence. That exact shape has already caused two bugs in this area --
 * `scannerEnginePlanForJob` rebuilt engine options from `textDetector` alone and lost the
 * score profile, and a mangled ternary turned `crossStaffFindings` into an empty array.
 * Neither raised anything; both were found later, from telemetry.
 *
 * An edit whose `source` went missing here would be filed as a comparison edit, asserting
 * that two independent readings disagreed where only one was ever consulted.
 */
function controller() {
  const calls: Record<string, unknown>[] = [];
  const scanner = {
    saveMergedScore: jest.fn(async (_u: string, _j: string, _p: number, input: never) => {
      calls.push(input);
      return {};
    })
  };
  return { calls, controller: new ScannerController(scanner as never), scanner };
}

const USER = { userId: 'user-1' } as never;

function save(
  harness: ReturnType<typeof controller>,
  editedMeasures?: string,
  findingKind?: string,
  findingPart?: string
) {
  return harness.controller.saveMergedScore(
    USER,
    'job-1',
    1,
    '<score/>',
    'ots-homr',
    'basis',
    '3',
    'true',
    editedMeasures,
    undefined,
    findingKind,
    findingPart
  );
}

describe('edited measure source survives the wire', () => {
  it('carries source through to the service', async () => {
    const harness = controller();
    await save(
      harness,
      JSON.stringify([{ measureIndex: 4, stablePartKey: 'P1', source: 'finding' }])
    );
    expect(harness.calls[0].editedMeasures).toEqual([
      { measureIndex: 4, stablePartKey: 'P1', source: 'finding' }
    ]);
  });

  it('leaves source absent when the client does not send one', async () => {
    // Absent means comparison, which is the meaning every stored record already has.
    const harness = controller();
    await save(harness, JSON.stringify([{ measureIndex: 0 }]));
    expect(harness.calls[0].editedMeasures).toEqual([{ measureIndex: 0 }]);
  });

  it('carries comparison explicitly too', async () => {
    const harness = controller();
    await save(harness, JSON.stringify([{ measureIndex: 2, source: 'comparison' }]));
    expect(harness.calls[0].editedMeasures).toEqual([
      { measureIndex: 2, source: 'comparison' }
    ]);
  });

  it('refuses an unknown source rather than coercing it', () => {
    // Coercing to comparison would quietly file the edit as a disagreement.
    // Thrown synchronously: the parse happens before the controller returns a promise,
    // so the request is refused without the service being reached at all.
    const harness = controller();
    expect(() =>
      save(harness, JSON.stringify([{ measureIndex: 1, source: 'guess' }]))
    ).toThrow(BadRequestException);
    expect(harness.scanner.saveMergedScore).not.toHaveBeenCalled();
  });

  it('still refuses a body that is not an array', () => {
    const harness = controller();
    expect(() => save(harness, '{"measureIndex":1}')).toThrow(BadRequestException);
  });

  it('carries the finding kind and part that prompted the edit', async () => {
    const harness = controller();
    await save(
      harness,
      JSON.stringify([{ measureIndex: 4, source: 'finding' }]),
      'clef_profile_mismatch',
      'cello'
    );
    expect(harness.calls[0]).toMatchObject({
      findingKind: 'clef_profile_mismatch',
      findingPart: 'cello'
    });
  });

  it('omits finding context entirely for an ordinary merge save', async () => {
    const harness = controller();
    await save(harness, JSON.stringify([{ measureIndex: 4 }]));
    expect(harness.calls[0]).not.toHaveProperty('findingKind');
    expect(harness.calls[0]).not.toHaveProperty('findingPart');
  });
});
