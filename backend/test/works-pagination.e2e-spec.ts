/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Works Pagination (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/works', () => {
    it('should return paginated results with default limit and offset', () => {
      return request(app.getHttpServer())
        .get('/api/works')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('works');
          expect(res.body).toHaveProperty('total');
          expect(res.body).toHaveProperty('limit');
          expect(res.body).toHaveProperty('offset');
          expect(Array.isArray(res.body.works)).toBe(true);
          expect(typeof res.body.total).toBe('number');
          expect(res.body.limit).toBe(20); // default
          expect(res.body.offset).toBe(0); // default
        });
    });

    it('should respect custom limit parameter', () => {
      return request(app.getHttpServer())
        .get('/api/works?limit=5')
        .expect(200)
        .expect((res) => {
          expect(res.body.limit).toBe(5);
          expect(res.body.works.length).toBeLessThanOrEqual(5);
        });
    });

    it('should respect custom offset parameter', () => {
      return request(app.getHttpServer())
        .get('/api/works?offset=10')
        .expect(200)
        .expect((res) => {
          expect(res.body.offset).toBe(10);
        });
    });

    it('should enforce max limit of 100', () => {
      return request(app.getHttpServer())
        .get('/api/works?limit=200')
        .expect(200)
        .expect((res) => {
          expect(res.body.limit).toBe(100); // capped at max
        });
    });

    it('should handle both limit and offset together', () => {
      return request(app.getHttpServer())
        .get('/api/works?limit=10&offset=5')
        .expect(200)
        .expect((res) => {
          expect(res.body.limit).toBe(10);
          expect(res.body.offset).toBe(5);
          expect(res.body.works.length).toBeLessThanOrEqual(10);
        });
    });

    it('should return correct pagination metadata with total count', () => {
      return request(app.getHttpServer())
        .get('/api/works')
        .expect(200)
        .expect((res) => {
          const { works, total, limit, offset } = res.body;
          // If there are works, ensure structure is correct
          if (works.length > 0) {
            expect(works[0]).toHaveProperty('workId');
            expect(works[0]).toHaveProperty('sourceCount');
            expect(works[0]).toHaveProperty('availableFormats');
          }
          // Total should be >= number of works returned
          expect(total).toBeGreaterThanOrEqual(works.length);
        });
    });

    it('should handle negative offset gracefully', () => {
      return request(app.getHttpServer())
        .get('/api/works?offset=-5')
        .expect(200)
        .expect((res) => {
          // Should treat negative offset as 0
          expect(res.body.offset).toBeGreaterThanOrEqual(0);
        });
    });

    it('should handle offset beyond total works', () => {
      return request(app.getHttpServer())
        .get('/api/works?offset=999999')
        .expect(200)
        .expect((res) => {
          expect(res.body.works).toEqual([]);
          expect(res.body.offset).toBe(999999);
        });
    });
  });
});
