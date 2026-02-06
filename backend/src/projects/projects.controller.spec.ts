import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

describe('ProjectsController (unit)', () => {
  const service = {
    listProjects: jest.fn(),
    createProject: jest.fn(),
    getProject: jest.fn(),
    updateProject: jest.fn(),
    joinProject: jest.fn(),
    updateMembers: jest.fn(),
    archiveProject: jest.fn(),
    listSources: jest.fn(),
    removeSource: jest.fn(),
    uploadSource: jest.fn(),
    listRows: jest.fn(),
    createRow: jest.fn(),
    updateRow: jest.fn(),
    deleteRow: jest.fn(),
    createInternalSource: jest.fn()
  } as any as jest.Mocked<ProjectsService>;

  const controller = new ProjectsController(service);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('list forwards query and optional user', async () => {
    service.listProjects.mockResolvedValue({ projects: [], total: 0, limit: 20, offset: 0 } as any);

    const result = await controller.list('10', '5', 'active', 'bach', { userId: 'u1', roles: ['user'] } as any);

    expect(service.listProjects).toHaveBeenCalledWith(
      { limit: 10, offset: 5, status: 'active', q: 'bach' },
      { userId: 'u1', roles: ['user'] }
    );
    expect(result).toEqual({ projects: [], total: 0, limit: 20, offset: 0 });
  });

  it('create passes actor and payload', async () => {
    service.createProject.mockResolvedValue({ projectId: 'prj_1' } as any);

    const out = await controller.create('My Project', undefined, 'desc', undefined, ['u2'], 'public', 'google', 'https://docs.google.com/spreadsheets/d/e/abc/pubhtml', 'https://docs.google.com/spreadsheets/d/abc/edit', { userId: 'u1', roles: [] } as any);

    expect(service.createProject).toHaveBeenCalledWith(
      {
        title: 'My Project',
        slug: undefined,
        description: 'desc',
        leadUserId: undefined,
        memberUserIds: ['u2'],
        visibility: 'public',
        spreadsheetProvider: 'google',
        spreadsheetEmbedUrl: 'https://docs.google.com/spreadsheets/d/e/abc/pubhtml',
        spreadsheetExternalUrl: 'https://docs.google.com/spreadsheets/d/abc/edit'
      },
      { userId: 'u1', roles: [] }
    );
    expect(out).toEqual({ projectId: 'prj_1' });
  });

  it('join delegates to service', async () => {
    service.joinProject.mockResolvedValue({ projectId: 'prj_1' } as any);
    const out = await controller.join('prj_1', { userId: 'u1', roles: ['user'] } as any);
    expect(service.joinProject).toHaveBeenCalledWith('prj_1', { userId: 'u1', roles: ['user'] });
    expect(out).toEqual({ projectId: 'prj_1' });
  });

  it('updateRow passes values', async () => {
    service.updateRow.mockResolvedValue({ rowId: 'row_1', rowVersion: 2 } as any);

    const out = await controller.updateRow(
      'prj_1',
      'row_1',
      { rowVersion: 1, notes: 'updated' },
      { userId: 'u1', roles: ['admin'] } as any
    );

    expect(service.updateRow).toHaveBeenCalledWith('prj_1', 'row_1', { rowVersion: 1, notes: 'updated' }, { userId: 'u1', roles: ['admin'] });
    expect(out).toEqual({ rowId: 'row_1', rowVersion: 2 });
  });

  it('createSource forwards payload', async () => {
    service.createInternalSource.mockResolvedValue({ ok: true, workId: '100', sourceId: 'src_1' } as any);

    const out = await controller.createSource(
      'prj_1',
      'row_1',
      { imslpUrl: 'https://imslp.org/wiki/Test' },
      { userId: 'u1', roles: ['user'] } as any
    );

    expect(service.createInternalSource).toHaveBeenCalledWith(
      'prj_1',
      'row_1',
      { imslpUrl: 'https://imslp.org/wiki/Test' },
      { userId: 'u1', roles: ['user'] }
    );
    expect(out).toEqual({ ok: true, workId: '100', sourceId: 'src_1' });
  });
});
