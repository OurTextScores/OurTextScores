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

import { render, RenderOptions } from '@testing-library/react';
import { ReactElement, ReactNode } from 'react';
import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';

// Mock session data for authenticated tests
export const mockSession: Session = {
  user: {
    email: 'test@example.com',
    name: 'Test User',
    image: null,
  },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

// Providers wrapper for components that need session context
interface ProvidersProps {
  children: ReactNode;
  session?: Session | null;
}

function Providers({ children, session = null }: ProvidersProps) {
  return (
    <SessionProvider session={session}>
      {children}
    </SessionProvider>
  );
}

// Custom render function with providers
interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  session?: Session | null;
}

export function renderWithProviders(
  ui: ReactElement,
  { session = null, ...renderOptions }: CustomRenderOptions = {}
) {
  return render(ui, {
    wrapper: ({ children }) => <Providers session={session}>{children}</Providers>,
    ...renderOptions,
  });
}

// Mock fetch helper
export function mockFetch(response: any, options: { ok?: boolean; status?: number } = {}) {
  const { ok = true, status = 200 } = options;
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response)
  );
}

// Mock failed fetch
export function mockFetchError(message = 'Network error', status = 500) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: false,
      status,
      text: async () => message,
    } as Response)
  );
}

// Helper to create mock File objects
export function createMockFile(
  name: string,
  type: string,
  content: string = 'mock file content'
): File {
  const blob = new Blob([content], { type });
  return new File([blob], name, { type });
}

// Re-export everything from testing-library
export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
