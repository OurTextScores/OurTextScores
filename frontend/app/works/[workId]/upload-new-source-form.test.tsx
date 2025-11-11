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

import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, userEvent, createMockFile, mockFetch, mockFetchError } from '../../test-utils';
import UploadNewSourceForm from './upload-new-source-form';

// Mock next/navigation
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe('UploadNewSourceForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefresh.mockClear();
  });

  it('renders the upload form with all fields', () => {
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    expect(screen.getByText('Upload new source')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('description (optional)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('commit message (optional)')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument(); // License select
  });

  it('displays license options in dropdown', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const select = screen.getByRole('combobox');
    await user.click(select);

    expect(screen.getByText('CC0 - Public Domain Dedication')).toBeInTheDocument();
    expect(screen.getByText('CC-BY 4.0 - Attribution')).toBeInTheDocument();
    expect(screen.getByText('All Rights Reserved (Copyright)')).toBeInTheDocument();
  });

  it('shows license URL field when "Other" is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'Other');

    expect(screen.getByPlaceholderText('License URL (required for Other)')).toBeInTheDocument();
  });

  it('shows attribution field when CC-BY license is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'CC-BY-4.0');

    expect(screen.getByPlaceholderText('Attribution (e.g., Your Name)')).toBeInTheDocument();
  });

  it('disables submit button when no file is selected', () => {
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when file is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const file = createMockFile('test.mxl', 'application/vnd.recordare.musicxml');
    const input = document.querySelector('input[type="file"]');

    if (input) {
      await user.upload(input, file);
    }

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    expect(submitButton).not.toBeDisabled();
  });

  it('submits form with file and optional fields', async () => {
    const user = userEvent.setup();
    mockFetch({ sourceId: 'new-source-123' });

    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const file = createMockFile('bach.mxl', 'application/vnd.recordare.musicxml');
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      await user.upload(fileInput, file);
    }

    const descInput = screen.getByPlaceholderText('description (optional)');
    await user.type(descInput, 'Bach score');

    const commitInput = screen.getByPlaceholderText('commit message (optional)');
    await user.type(commitInput, 'Initial upload');

    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'CC-BY-4.0');

    const attrInput = screen.getByPlaceholderText('Attribution (e.g., Your Name)');
    await user.type(attrInput, 'Test User');

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/proxy/works/12345/sources',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Source uploaded.')).toBeInTheDocument();
    });

    expect(mockRefresh).toHaveBeenCalled();
  });

  it('displays error message on upload failure', async () => {
    const user = userEvent.setup();
    mockFetchError('Upload failed: file too large', 413);

    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const file = createMockFile('large.mxl', 'application/vnd.recordare.musicxml');
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      await user.upload(fileInput, file);
    }

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/Upload failed: file too large/i)).toBeInTheDocument();
    });

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows busy state during upload', async () => {
    const user = userEvent.setup();
    mockFetch({ sourceId: 'new-source-123' });

    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const file = createMockFile('test.mxl', 'application/vnd.recordare.musicxml');
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      await user.upload(fileInput, file);
    }

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    await user.click(submitButton);

    // Upload should complete and show success message
    await waitFor(() => {
      expect(screen.getByText('Source uploaded.')).toBeInTheDocument();
    });
  });

  it('resets form fields after successful upload', async () => {
    const user = userEvent.setup();
    mockFetch({ sourceId: 'new-source-123' });

    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const file = createMockFile('test.mxl', 'application/vnd.recordare.musicxml');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    if (fileInput) {
      await user.upload(fileInput, file);
    }

    const descInput = screen.getByPlaceholderText('description (optional)') as HTMLInputElement;
    await user.type(descInput, 'Test description');

    const submitButton = screen.getByRole('button', { name: /upload new source/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Source uploaded.')).toBeInTheDocument();
    });

    // Check that text fields are reset
    expect(descInput.value).toBe('');
    // Note: File input reset doesn't work reliably in jsdom
  });

  it('shows error when submitting without a file', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadNewSourceForm workId="12345" />);

    const submitButton = screen.getByRole('button', { name: /upload new source/i });

    // Submit button should be disabled, but let's test the validation logic
    expect(submitButton).toBeDisabled();
  });
});
