# Backend Test Coverage Improvement Plan

**Current Overall Coverage:** 52.78% statements, 39.15% branch, 37.5% functions, 52.81% lines
**Target Coverage:** 80%+ statements, 70%+ branch, 75%+ functions, 80%+ lines

---

## Phase 1: Critical Infrastructure (Priority: CRITICAL)
**Goal:** Fix failing tests and cover essential services with 0-20% coverage

### 1.1 Fix IMSLP Service Tests (BLOCKING) 🔴
- **File:** `src/imslp/imslp.service.ts`
- **Current Coverage:** 4.52% (FAILING TESTS)
- **Priority:** URGENT - blocking all tests
- **Effort:** Medium
- **Tasks:**
  - Fix TypeScript error in `imslp.service.spec.ts` (line 77)
  - Mock `execFile` properly with jest
  - Add tests for XML parsing
  - Test work metadata extraction
  - Test error handling for malformed XML
  - Cover all 680 lines of business logic

### 1.2 Storage Service 🔴
- **File:** `src/storage/storage.service.ts`
- **Current Coverage:** 5.55% (NO TESTS)
- **Priority:** HIGH - core infrastructure
- **Effort:** High
- **Tasks:**
  - Create `storage.service.spec.ts`
  - Mock MinIO/S3 client
  - Test file upload operations
  - Test file download/retrieval
  - Test URL generation for stored objects
  - Test error handling (connection failures, invalid files)
  - Cover lines 29-152

### 1.3 Fossil Service 🔴
- **File:** `src/fossil/fossil.service.ts`
- **Current Coverage:** 8.33% (NO TESTS)
- **Priority:** MEDIUM - version control backend
- **Effort:** High
- **Tasks:**
  - Create `fossil.service.spec.ts`
  - Mock fossil CLI operations
  - Test repository initialization
  - Test commit operations
  - Test branch management
  - Test checkout operations
  - Cover lines 36-211

---

## Phase 2: Authentication & Authorization (Priority: HIGH)
**Goal:** Ensure security layer is well-tested

### 2.1 Auth Guards 🟡
- **Files:**
  - `src/auth/guards/auth-optional.guard.ts` (35.29% - NO TESTS)
  - `src/auth/guards/auth-required.guard.ts` (33.33% - NO TESTS)
- **Priority:** HIGH - security critical
- **Effort:** Low-Medium
- **Tasks:**
  - Create `auth-optional.guard.spec.ts`
  - Create `auth-required.guard.spec.ts`
  - Test canActivate() method
  - Test request context extraction
  - Test with valid/invalid tokens
  - Test with missing tokens
  - Mock ExecutionContext and AuthService

### 2.2 Current User Decorator 🟡
- **File:** `src/auth/current-user.decorator.ts`
- **Current Coverage:** 50% (NO TESTS)
- **Priority:** MEDIUM
- **Effort:** Low
- **Tasks:**
  - Create `current-user.decorator.spec.ts`
  - Test user extraction from request
  - Test with authenticated/unauthenticated requests

---

## Phase 3: Core Business Services (Priority: HIGH)
**Goal:** Improve coverage of main application logic

### 3.1 Users Service 🟡
- **File:** `src/users/users.service.ts`
- **Current Coverage:** 43.75% (NO TESTS)
- **Priority:** HIGH - core user management
- **Effort:** Medium
- **Tasks:**
  - Create `users.service.spec.ts`
  - Test user creation
  - Test user retrieval by ID/email
  - Test user updates
  - Mock UserModel (Mongoose)
  - Cover lines 17-48

### 3.2 Search Service 🟡
- **File:** `src/search/search.service.ts`
- **Current Coverage:** 40.27% (HAS TESTS)
- **Priority:** MEDIUM
- **Effort:** Medium
- **Tasks:**
  - Expand `search.service.spec.ts`
  - Test full-text search
  - Test filtering and pagination
  - Test aggregation queries
  - Cover uncovered lines: 51-110, 123-130, 142-147, 159-163, 191-207, 224-228, 240-245

### 3.3 Branches Service 🟡
- **File:** `src/branches/branches.service.ts`
- **Current Coverage:** 51.85% (HAS TESTS)
- **Priority:** MEDIUM
- **Effort:** Medium
- **Tasks:**
  - Expand `branches.service.spec.ts`
  - Test branch creation
  - Test branch listing
  - Test branch switching
  - Cover uncovered lines: 30-36, 59, 69-97

---

## Phase 4: Works Module Enhancement (Priority: MEDIUM)
**Goal:** Improve coverage of work management features

### 4.1 Works Controller 🟡
- **File:** `src/works/works.controller.ts`
- **Current Coverage:** 33.86% (HAS TESTS)
- **Priority:** MEDIUM - many endpoints
- **Effort:** High
- **Tasks:**
  - Expand `works.controller.spec.ts`
  - Test all REST endpoints
  - Test error responses
  - Test input validation
  - Cover large uncovered sections

### 4.2 Derivative Pipeline Service 🟡
- **File:** `src/works/derivative-pipeline.service.ts`
- **Current Coverage:** 47.08% (HAS TESTS)
- **Priority:** MEDIUM - file processing
- **Effort:** High
- **Tasks:**
  - Expand `derivative-pipeline.service.spec.ts`
  - Mock external tools (MuseScore, lilypond)
  - Test PDF generation
  - Test XML processing
  - Test error recovery
  - Cover uncovered lines

### 4.3 Upload Source Service 🟡
- **File:** `src/works/upload-source.service.ts`
- **Current Coverage:** 61.58% (HAS TESTS)
- **Priority:** MEDIUM
- **Effort:** Medium
- **Tasks:**
  - Expand `upload-source.service.spec.ts`
  - Test file validation
  - Test various file formats (.mxl, .xml, .mscz)
  - Test upload with branches
  - Cover uncovered lines

---

## Phase 5: Supporting Services (Priority: LOW-MEDIUM)
**Goal:** Complete coverage of remaining services

### 5.1 Notifications Service 🟢
- **File:** `src/notifications/notifications.service.ts`
- **Current Coverage:** 56.88% (HAS TESTS)
- **Priority:** LOW
- **Effort:** Medium
- **Tasks:**
  - Expand `notifications.service.spec.ts`
  - Test notification creation
  - Test notification delivery
  - Test email notifications
  - Cover uncovered lines: 70-88, 104-105, 113, 120-123, 141-164, 174, 185

### 5.2 Progress Service 🟢
- **File:** `src/progress/progress.service.ts`
- **Current Coverage:** 76.92% (NO TESTS)
- **Priority:** LOW
- **Effort:** Low
- **Tasks:**
  - Create `progress.service.spec.ts`
  - Test SSE event emission
  - Test progress tracking
  - Cover lines 16-21

---

## Testing Guidelines & Best Practices

### Mocking Strategy
```typescript
// For Mongoose models
const mockModel = {
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
};

// For external services
jest.mock('minio');
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
```

### Test Structure
```typescript
describe('ServiceName', () => {
  let service: ServiceName;
  let mockDependency: jest.Mocked<DependencyType>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ServiceName,
        { provide: DependencyToken, useValue: mockDependency },
      ],
    }).compile();

    service = module.get<ServiceName>(ServiceName);
  });

  describe('methodName', () => {
    it('should handle success case', () => { /* ... */ });
    it('should handle error case', () => { /* ... */ });
    it('should validate input', () => { /* ... */ });
  });
});
```

### Coverage Targets per Phase
- **Phase 1:** Bring critical files to 80%+
- **Phase 2:** Bring auth to 90%+ (security critical)
- **Phase 3:** Bring core services to 75%+
- **Phase 4:** Bring works module to 70%+
- **Phase 5:** Bring supporting services to 70%+

---

## Priority Matrix

| File | Coverage | Priority | Effort | Impact | Phase |
|------|----------|----------|--------|--------|-------|
| imslp.service.ts | 4.52% | 🔴 CRITICAL | Medium | High | 1 |
| storage.service.ts | 5.55% | 🔴 HIGH | High | High | 1 |
| fossil.service.ts | 8.33% | 🟡 MEDIUM | High | Medium | 1 |
| auth-*.guard.ts | ~34% | 🔴 HIGH | Low | High | 2 |
| users.service.ts | 43.75% | 🔴 HIGH | Medium | High | 3 |
| search.service.ts | 40.27% | 🟡 MEDIUM | Medium | Medium | 3 |
| works.controller.ts | 33.86% | 🟡 MEDIUM | High | Medium | 4 |
| derivative-pipeline.service.ts | 47.08% | 🟡 MEDIUM | High | Medium | 4 |
| branches.service.ts | 51.85% | 🟡 MEDIUM | Medium | Medium | 3 |
| upload-source.service.ts | 61.58% | 🟢 LOW | Medium | Low | 4 |
| notifications.service.ts | 56.88% | 🟢 LOW | Medium | Low | 5 |
| progress.service.ts | 76.92% | 🟢 LOW | Low | Low | 5 |

---

## Estimated Timeline

### Sprint 1 (Week 1-2): Phase 1 - Critical Infrastructure
- Fix imslp.service.spec.ts (2 days)
- Create storage.service.spec.ts (3 days)
- Create fossil.service.spec.ts (3 days)
- **Target:** 60% overall coverage

### Sprint 2 (Week 3): Phase 2 - Authentication
- Create auth guard tests (2 days)
- Create decorator tests (1 day)
- **Target:** 65% overall coverage

### Sprint 3 (Week 4-5): Phase 3 - Core Services
- Create users.service.spec.ts (2 days)
- Expand search.service.spec.ts (2 days)
- Expand branches.service.spec.ts (2 days)
- **Target:** 72% overall coverage

### Sprint 4 (Week 6-7): Phase 4 - Works Module
- Expand works.controller.spec.ts (3 days)
- Expand derivative-pipeline.service.spec.ts (2 days)
- Expand upload-source.service.spec.ts (2 days)
- **Target:** 78% overall coverage

### Sprint 5 (Week 8): Phase 5 - Supporting Services
- Expand notifications.service.spec.ts (2 days)
- Create progress.service.spec.ts (1 day)
- **Target:** 80%+ overall coverage

---

## Success Metrics

- ✅ All test suites passing (currently 1 failing)
- ✅ Overall statement coverage > 80%
- ✅ Overall branch coverage > 70%
- ✅ Overall function coverage > 75%
- ✅ Zero files with < 50% coverage
- ✅ All critical services (auth, storage, imslp) > 90% coverage

---

## Quick Wins (Low Effort, High Impact)

1. **Fix imslp.service.spec.ts** - Unblocks all tests (1 day)
2. **Auth Guards** - Security critical, low effort (2 days)
3. **Progress Service** - Already 77%, easy to complete (1 day)
4. **Current User Decorator** - Simple, 50% already (1 day)

**Total Quick Wins Time:** ~5 days to improve from 52% to ~60% coverage

---

## Notes

- All tests should follow NestJS testing best practices
- Use `@nestjs/testing` Test module for dependency injection
- Mock external dependencies (databases, file systems, APIs)
- Focus on business logic, not just line coverage
- Include edge cases and error handling
- Document complex test setups
- Use descriptive test names following "should [do something] when [condition]" pattern
