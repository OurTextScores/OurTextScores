# Backend E2E Tests

This directory contains end-to-end (E2E) tests for the OurTextScores backend API.

## Test Files

### `smoke.e2e-spec.ts`
Comprehensive smoke tests covering critical user flows:
- Work creation and source uploads
- License metadata (CC0, CC-BY, etc.)
- Derivative generation (PDF, XML)
- Branch operations
- Watch/subscribe functionality
- Search operations

### `licensing.e2e-spec.ts`
User content licensing feature tests:
- CC0 - Public Domain Dedication
- CC-BY-4.0 - Attribution
- CC-BY-SA-4.0 - Attribution-ShareAlike
- CC-BY-NC-4.0 - Attribution-NonCommercial
- Public Domain
- All Rights Reserved
- Custom licenses with URLs
- License persistence across API endpoints

## Prerequisites

The E2E tests require the following services to be running:

```bash
# Start Docker services
cd /home/jhlusko/workspace/OurTextScores
docker compose up -d mongodb minio mailpit
```

The backend application must also be running:

```bash
cd /home/jhlusko/workspace/OurTextScores/backend
npm run start:dev
```

## Running Tests

### Run all E2E tests
```bash
npm run test:e2e
```

### Run smoke tests only
```bash
npm run test:smoke
```

### Run specific test file
```bash
npm run test:e2e -- licensing.e2e-spec.ts
```

### Run tests in watch mode
```bash
npm run test:e2e -- --watch
```

### Run tests with verbose output
```bash
npm run test:e2e -- --verbose
```

## Test Architecture

The E2E tests use:
- **NestJS Testing Module**: Creates a real application instance
- **Supertest**: Makes HTTP requests to the API
- **Jest**: Test runner and assertion library

Tests interact with real services (MongoDB, MinIO) to verify end-to-end behavior, not mocked dependencies.

## Test Data Cleanup

Most tests clean up after themselves by deleting created works. However, if tests fail or are interrupted, you may need to manually clean up test data:

```bash
# Connect to MongoDB
docker exec -it ourtextscores-mongodb-1 mongosh

# In MongoDB shell
use ourtextscores
db.works.deleteMany({ title: /Test/ })
db.sources.deleteMany({})
db.sourceRevisions.deleteMany({})
```

## Writing New E2E Tests

When adding new E2E tests:

1. Create a new `.e2e-spec.ts` file in this directory
2. Import and bootstrap the `AppModule`
3. Use `supertest` to make HTTP requests
4. Clean up test data in `afterAll()` or `afterEach()`
5. Use realistic test data (small files, valid formats)
6. Set appropriate timeouts for slow operations (derivative generation, PDF creation)

Example:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('My Feature (e2e)', () => {
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

  it('should do something', () => {
    return request(app.getHttpServer())
      .get('/api/endpoint')
      .expect(200);
  });
});
```

## CI/CD Integration

These tests can be integrated into CI/CD pipelines:

```bash
# Start services
docker compose up -d mongodb minio

# Wait for services to be ready
sleep 5

# Run backend in background
npm run start &
BACKEND_PID=$!

# Wait for backend to start
sleep 10

# Run E2E tests
npm run test:e2e

# Cleanup
kill $BACKEND_PID
docker compose down
```

## Troubleshooting

### Tests timing out
- Increase timeout in `jest-e2e.config.ts` (currently 30 seconds)
- Check that Docker services are running
- Verify backend is running and accessible

### Connection errors
```
ECONNREFUSED 127.0.0.1:3000
```
- Ensure backend is running on port 3000
- Check `docker compose ps` to verify services are up

### MongoDB connection errors
```
MongoServerError: Authentication failed
```
- Check MongoDB credentials in `.env` or environment variables
- Verify MongoDB container is running

### MinIO errors
```
MinIO bucket not found
```
- Ensure MinIO is running
- Check that buckets are created (backend should auto-create on startup)

## Future Improvements

- [ ] Add performance benchmarks
- [ ] Test with larger files
- [ ] Add concurrent upload tests
- [ ] Test rate limiting
- [ ] Add security/auth tests
- [ ] Test file size limits
- [ ] Add stress tests for derivative pipeline
