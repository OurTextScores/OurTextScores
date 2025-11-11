// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Mock Next.js router
jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    refresh: jest.fn(),
    pathname: '/',
    query: {},
  })),
  usePathname: jest.fn(() => '/'),
  useSearchParams: jest.fn(() => new URLSearchParams()),
  notFound: jest.fn(),
  redirect: jest.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}))

// Mock next-auth
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(() => ({
    data: null,
    status: 'unauthenticated',
  })),
  signIn: jest.fn(),
  signOut: jest.fn(),
  SessionProvider: ({ children }) => children,
}))

jest.mock('./app/lib/authToken', () => ({
  getApiAuthHeaders: jest.fn(() => Promise.resolve({ "Authorization": "Bearer test-token" })),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

// Suppress console errors during tests (optional)
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
}
