import { PdmxService } from './pdmx.service';

function leanExec<T>(result: T) {
  return {
    lean: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result)
  } as any;
}

describe('PdmxService (unit, mocked model)', () => {
  let service: PdmxService;
  let pdmxModel: any;

  beforeEach(() => {
    jest.resetAllMocks();
    pdmxModel = {
      countDocuments: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn()
    };

    const projectsService = {
      uploadSource: jest.fn()
    } as any;
    const worksService = {
      verifySource: jest.fn()
    } as any;
    const config = {
      get: jest.fn()
    } as any;

    service = new PdmxService(pdmxModel, projectsService, worksService, config);
  });

  it('listRecords applies default filters and marks hasPdf/hasMxl', async () => {
    pdmxModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });
    pdmxModel.find.mockReturnValue(
      leanExec([
        {
          pdmxId: 'A1',
          title: 'Title',
          subsets: { noLicenseConflict: true },
          review: { qualityStatus: 'unknown', excludedFromSearch: false },
          assets: { pdfPath: 'pdfs/A1.pdf', mxlPath: 'mxl/A1.mxl' }
        }
      ])
    );

    const out = await service.listRecords({});

    expect(pdmxModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        'review.qualityStatus': { $ne: 'unacceptable' },
        'review.excludedFromSearch': { $ne: true },
        'subsets.noLicenseConflict': true
      })
    );
    expect(out.total).toBe(1);
    expect(out.items[0]).toEqual(expect.objectContaining({ hasPdf: true, hasMxl: true }));
  });

  it('listRecords supports text query with hasPdf=false without losing text match conditions', async () => {
    pdmxModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });
    pdmxModel.find.mockReturnValue(leanExec([]));

    await service.listRecords({ q: 'mozart', hasPdf: false, excludeUnacceptable: false, requireNoLicenseConflict: false });

    const query = pdmxModel.countDocuments.mock.calls[0][0];
    expect(Array.isArray(query.$or)).toBe(true);
    expect(query.$and).toEqual(
      expect.arrayContaining([
        {
          $or: [{ 'assets.pdfPath': { $exists: false } }, { 'assets.pdfPath': '' }]
        }
      ])
    );
  });

  it('updateReview uses $unset when reason/notes are intentionally cleared', async () => {
    pdmxModel.findOneAndUpdate.mockReturnValue(
      leanExec({
        pdmxId: 'A1',
        review: { qualityStatus: 'acceptable', excludedFromSearch: false }
      })
    );

    await service.updateReview(
      'A1',
      { qualityStatus: 'acceptable', reason: '   ', notes: '' },
      { userId: 'admin_1', roles: ['admin'] } as any
    );

    expect(pdmxModel.findOneAndUpdate).toHaveBeenCalledWith(
      { pdmxId: 'A1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'review.qualityStatus': 'acceptable',
          'review.updatedBy': 'admin_1'
        }),
        $unset: expect.objectContaining({
          'review.reason': '',
          'review.notes': ''
        })
      }),
      { new: true }
    );
  });

  it('updateImportState tracks updater and unsets empty optional fields', async () => {
    pdmxModel.findOneAndUpdate.mockReturnValue(
      leanExec({
        pdmxId: 'A1',
        import: { status: 'not_imported' }
      })
    );

    await service.updateImportState(
      'A1',
      {
        status: 'failed',
        importedWorkId: '',
        importedSourceId: '',
        importedProjectId: '',
        imslpUrl: '',
        error: ''
      },
      { userId: 'admin_2', roles: ['admin'] } as any
    );

    expect(pdmxModel.findOneAndUpdate).toHaveBeenCalledWith(
      { pdmxId: 'A1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'import.status': 'failed',
          'import.updatedBy': 'admin_2'
        }),
        $unset: expect.objectContaining({
          'import.importedWorkId': '',
          'import.importedSourceId': '',
          'import.importedProjectId': '',
          'import.imslpUrl': '',
          'import.error': ''
        })
      }),
      { new: true }
    );
  });

  it('updateImportState clears imported linkage fields when status becomes not_imported', async () => {
    pdmxModel.findOneAndUpdate.mockReturnValue(
      leanExec({
        pdmxId: 'A1',
        import: { status: 'not_imported' }
      })
    );

    await service.updateImportState(
      'A1',
      { status: 'not_imported' },
      { userId: 'admin_3', roles: ['admin'] } as any
    );

    expect(pdmxModel.findOneAndUpdate).toHaveBeenCalledWith(
      { pdmxId: 'A1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'import.status': 'not_imported',
          'import.updatedBy': 'admin_3'
        }),
        $unset: expect.objectContaining({
          'import.importedWorkId': '',
          'import.importedSourceId': '',
          'import.importedRevisionId': '',
          'import.importedProjectId': '',
          'import.imslpUrl': '',
          'import.error': ''
        })
      }),
      { new: true }
    );
  });

  it('listGroups returns ranked groups from aggregation output', async () => {
    pdmxModel.aggregate.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          items: [
            {
              _id: 'piano',
              count: 100,
              unacceptableCount: 7,
              excludedCount: 7,
              importedCount: 11,
              withPdfCount: 99,
              noLicenseConflictCount: 97
            }
          ],
          meta: [{ totalGroups: 1 }]
        }
      ])
    });

    const out = await service.listGroups({ limit: 10, offset: 0, subset: 'all_valid' });

    expect(pdmxModel.aggregate).toHaveBeenCalledTimes(1);
    expect(out.totalGroups).toBe(1);
    expect(out.items[0]).toEqual({
      group: 'piano',
      count: 100,
      unacceptableCount: 7,
      excludedCount: 7,
      importedCount: 11,
      withPdfCount: 99,
      noLicenseConflictCount: 97
    });
  });

  it('markGroupUnacceptable updates all rows in matching group', async () => {
    pdmxModel.updateMany.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 12, modifiedCount: 12 })
    });

    const out = await service.markGroupUnacceptable(
      'youngcomposersgroup',
      { reason: 'Bulk admin review' },
      { userId: 'admin_group_1', roles: ['admin'] } as any
    );

    expect(pdmxModel.updateMany).toHaveBeenCalledWith(
      {
        groups: {
          $regex: expect.any(RegExp)
        }
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          'review.qualityStatus': 'unacceptable',
          'review.excludedFromSearch': true,
          'review.reason': 'Bulk admin review',
          'review.updatedBy': 'admin_group_1'
        })
      })
    );
    expect(out).toEqual({
      ok: true,
      group: 'youngcomposersgroup',
      matchedCount: 12,
      modifiedCount: 12
    });
  });
});
