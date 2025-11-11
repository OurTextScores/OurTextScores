import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController]
    }).compile();
    controller = module.get<HealthController>(HealthController);
  });

  it('should return ok status', () => {
    const res = controller.get();
    expect(res).toHaveProperty('status', 'ok');
    expect(typeof res.time).toBe('string');
  });
});

