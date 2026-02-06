import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';

describe('ProjectsController (integration-style module test)', () => {
  let controller: ProjectsController;
  let service: jest.Mocked<ProjectsService>;

  beforeEach(async () => {
    service = {
      listProjects: jest.fn(),
      createProject: jest.fn(),
      getProject: jest.fn(),
      updateProject: jest.fn(),
      updateMembers: jest.fn(),
      archiveProject: jest.fn(),
      listRows: jest.fn(),
      createRow: jest.fn(),
      updateRow: jest.fn(),
      deleteRow: jest.fn(),
      createInternalSource: jest.fn()
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: service },
        { provide: AuthService, useValue: { optionalUser: jest.fn(), requireUser: jest.fn() } },
        { provide: UsersService, useValue: { getOrCreateByEmail: jest.fn() } },
        AuthOptionalGuard,
        AuthRequiredGuard
      ]
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
  });

  it('list parses pagination args and delegates', async () => {
    service.listProjects.mockResolvedValue({ projects: [], total: 0, limit: 20, offset: 0 } as any);

    const result = await controller.list('25', '10', 'active', 'mozart', { userId: 'u1', roles: ['user'] } as any);

    expect(service.listProjects).toHaveBeenCalledWith(
      { limit: 25, offset: 10, status: 'active', q: 'mozart' },
      { userId: 'u1', roles: ['user'] }
    );
    expect(result).toEqual({ projects: [], total: 0, limit: 20, offset: 0 });
  });

  it('rows forwards optional auth context', async () => {
    service.listRows.mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0 } as any);

    const result = await controller.rows('prj_1', '50', '0', undefined);

    expect(service.listRows).toHaveBeenCalledWith('prj_1', { limit: 50, offset: 0 }, undefined);
    expect(result.rows).toEqual([]);
  });

  it('createSource forwards payload and actor', async () => {
    service.createInternalSource.mockResolvedValue({ ok: true, workId: '5000', sourceId: 'src_1' } as any);

    const out = await controller.createSource(
      'prj_1',
      'row_1',
      { workId: '5000', sourceLabel: 'Imported Source' },
      { userId: 'u1', roles: ['user'] } as any
    );

    expect(service.createInternalSource).toHaveBeenCalledWith(
      'prj_1',
      'row_1',
      { workId: '5000', sourceLabel: 'Imported Source' },
      { userId: 'u1', roles: ['user'] }
    );
    expect(out).toEqual({ ok: true, workId: '5000', sourceId: 'src_1' });
  });
});
