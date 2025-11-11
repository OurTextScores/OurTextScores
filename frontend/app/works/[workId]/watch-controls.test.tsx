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

import { render, screen } from '@testing-library/react';
import { mockFetch } from '../../test-utils';
import WatchControls from './watch-controls';

// Mock server-side modules
jest.mock('../../lib/api', () => ({
  getApiBase: () => 'http://localhost:4000/api',
}));

jest.mock('../../lib/authToken', () => ({
  getApiAuthHeaders: jest.fn(),
}));

jest.mock('./watch-actions', () => ({
  watchSourceAction: jest.fn(),
  unwatchSourceAction: jest.fn(),
}));

const { getApiAuthHeaders } = require('../../lib/authToken');

describe('WatchControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows sign-in link when not authenticated', async () => {
    getApiAuthHeaders.mockResolvedValue(null);
    mockFetch({ count: 5, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    expect(screen.getByText(/Sign in to watch \(5\)/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/api/auth/signin');
  });

  it('shows watch button when authenticated but not subscribed', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 3, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    expect(screen.getByRole('button', { name: /Watch \(3\)/i })).toBeInTheDocument();
  });

  it('shows watching button when subscribed', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 10, subscribed: true });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    expect(screen.getByRole('button', { name: /Watching \(10\)/i })).toBeInTheDocument();
  });

  it('displays watcher count correctly', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 42, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    expect(screen.getByText(/\(42\)/)).toBeInTheDocument();
  });

  it('handles zero watchers', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 0, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    expect(screen.getByText(/Watch \(0\)/i)).toBeInTheDocument();
  });

  it('handles API errors gracefully', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      } as Response)
    );

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    // Should default to count: 0, subscribed: false
    expect(screen.getByRole('button', { name: /Watch \(0\)/i })).toBeInTheDocument();
  });

  it('handles malformed API response', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch(null); // Malformed response

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    // Should default to count: 0
    expect(screen.getByRole('button', { name: /Watch \(0\)/i })).toBeInTheDocument();
  });

  it('applies correct styles to subscribed button', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 5, subscribed: true });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('bg-slate-200');
  });

  it('applies correct styles to unsubscribed button', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 5, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    render(component);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('bg-cyan-600');
  });

  it('includes form for server action', async () => {
    getApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
    mockFetch({ count: 5, subscribed: false });

    const component = await WatchControls({ workId: '12345', sourceId: 'source-1' });
    const { container } = render(component);

    expect(container.querySelector('form')).toBeInTheDocument();
  });
});
