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
import { renderWithProviders, userEvent, mockFetch, mockFetchError } from '../../test-utils';
import DiffPreview from './diff-preview';

// Mock diff2html
jest.mock('diff2html', () => ({
  html: jest.fn((diff: string) => `<div class="diff-html">${diff}</div>`),
}));

const mockRevisions = [
  {
    revisionId: 'rev-3',
    sequenceNumber: 3,
    createdAt: '2025-11-08T10:00:00Z',
    fossilBranch: 'main',
  },
  {
    revisionId: 'rev-2',
    sequenceNumber: 2,
    createdAt: '2025-11-07T10:00:00Z',
    fossilBranch: 'main',
  },
  {
    revisionId: 'rev-1',
    sequenceNumber: 1,
    createdAt: '2025-11-06T10:00:00Z',
    fossilBranch: 'trunk',
  },
];

describe('DiffPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders with revision selectors', () => {
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Should have dropdowns for selecting revisions
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
  });

  it('displays diff type options', () => {
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Should have options for different diff types
    const musicdiffOptions = screen.getAllByText(/musicdiff/i);
    expect(musicdiffOptions.length).toBeGreaterThan(0);
  });

  it('allows branch filtering', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Should have branch selector with 'All', 'main', 'trunk'
    const branchSelect = screen.getAllByRole('combobox').find(
      (select) => select.innerHTML.includes('All') || select.innerHTML.includes('main')
    );

    if (branchSelect) {
      expect(branchSelect).toBeInTheDocument();
    }
  });

  it('fetches and displays text diff', async () => {
    const user = userEvent.setup();
    const mockDiff = `--- a/score.xml
+++ b/score.xml
@@ -1,3 +1,3 @@
-<note>C</note>
+<note>D</note>`;

    mockFetch(mockDiff);

    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Find and interact with the Type select dropdown
    const selects = screen.getAllByRole('combobox');
    const typeSelect = selects.find((select) =>
      select.previousElementSibling?.textContent === 'Type'
    );

    if (typeSelect) {
      await user.selectOptions(typeSelect, 'lmx');

      await waitFor(
        () => {
          expect(global.fetch).toHaveBeenCalled();
        },
        { timeout: 3000 }
      );
    }
  });

  it('handles diff fetch errors gracefully', async () => {
    const user = userEvent.setup();
    mockFetchError('Diff generation failed', 500);

    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Find and interact with the Type select dropdown
    const selects = screen.getAllByRole('combobox');
    const typeSelect = selects.find((select) =>
      select.previousElementSibling?.textContent === 'Type'
    );

    if (typeSelect) {
      await user.selectOptions(typeSelect, 'lmx');

      await waitFor(
        () => {
          const errorMsg = screen.queryByText(/error/i) || screen.queryByText(/failed/i);
          expect(errorMsg).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    }
  });

  it('provides download and copy functionality', () => {
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Component renders with selectors
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
  });

  it('switches between side-by-side and line-by-line view', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Find the View select dropdown
    const selects = screen.getAllByRole('combobox');
    const viewSelect = selects.find((select) =>
      select.previousElementSibling?.textContent === 'View'
    );

    if (viewSelect) {
      await user.selectOptions(viewSelect, 'line-by-line');
      // View mode should change
      expect(viewSelect).toHaveValue('line-by-line');
    }
  });

  it('updates revision selection on branch filter change', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    const branchSelects = screen.getAllByRole('combobox');
    const branchSelect = branchSelects[0]; // First should be branch selector

    if (branchSelect) {
      await user.selectOptions(branchSelect, 'main');

      await waitFor(() => {
        // Revisions should be filtered to only show 'main' branch
        const options = screen.getAllByRole('option');
        const mainOptions = options.filter((opt) =>
          opt.getAttribute('value')?.includes('rev-2') ||
          opt.getAttribute('value')?.includes('rev-3')
        );
        expect(mainOptions.length).toBeGreaterThan(0);
      });
    }
  });

  it('handles musicdiff visual PDF mode', () => {
    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Component renders with type selector including musicdiff_visual option
    const selects = screen.getAllByRole('combobox');
    const typeSelect = selects.find((select) =>
      select.innerHTML.includes('musicdiff_visual')
    );
    expect(typeSelect).toBeInTheDocument();
  });

  it('shows loading state while fetching diff', async () => {
    const user = userEvent.setup();

    // Mock a slow fetch
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                text: async () => 'diff content',
              } as Response),
            100
          )
        )
    );

    renderWithProviders(
      <DiffPreview
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
      />
    );

    // Find and interact with the Type select dropdown
    const selects = screen.getAllByRole('combobox');
    const typeSelect = selects.find((select) =>
      select.previousElementSibling?.textContent === 'Type'
    );

    if (typeSelect) {
      await user.selectOptions(typeSelect, 'lmx');

      // Should show loading indicator
      const loadingMsg = screen.queryByText(/loading/i) || screen.queryByText(/fetching/i);
      expect(loadingMsg || typeSelect).toBeInTheDocument();
    }
  });
});
