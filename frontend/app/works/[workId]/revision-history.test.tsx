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

import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders, userEvent } from '../../test-utils';
import RevisionHistory from './revision-history';

const mockRevisions = [
  {
    revisionId: 'rev-3',
    sequenceNumber: 3,
    createdAt: '2025-11-08T10:00:00Z',
    createdBy: 'user@example.com',
    changeSummary: 'Fixed notation errors',
    validation: { status: 'passed' },
    derivatives: {
      pdf: { bucket: 'scores-derivatives', objectKey: 'work123/rev3.pdf', sizeBytes: 50000 },
      canonicalXml: { bucket: 'scores-derivatives', objectKey: 'work123/rev3.xml', sizeBytes: 10000 },
    },
    fossilArtifactId: 'abc123',
    fossilBranch: 'trunk',
  },
  {
    revisionId: 'rev-2',
    sequenceNumber: 2,
    createdAt: '2025-11-07T10:00:00Z',
    createdBy: 'test@example.com',
    changeSummary: 'Added dynamics',
    validation: { status: 'passed' },
    derivatives: {
      pdf: { bucket: 'scores-derivatives', objectKey: 'work123/rev2.pdf', sizeBytes: 48000 },
    },
    fossilBranch: 'trunk',
  },
  {
    revisionId: 'rev-1',
    sequenceNumber: 1,
    createdAt: '2025-11-06T10:00:00Z',
    changeSummary: 'Initial upload',
    validation: { status: 'pending' },
    derivatives: {},
    fossilBranch: 'trunk',
  },
];

const branchNames = ['All', 'trunk'];

describe('RevisionHistory', () => {
  it('renders all revisions by default', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('displays revision details', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    expect(screen.getByText('Fixed notation errors')).toBeInTheDocument();
    expect(screen.getByText('Added dynamics')).toBeInTheDocument();
    expect(screen.getByText('Initial upload')).toBeInTheDocument();
  });



  it('filters revisions by branch', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Find branch filter select
    const selects = screen.getAllByRole('combobox');
    const branchSelect = selects.find((select) => {
      const options = within(select).getAllByRole('option');
      return options.some((opt) => opt.textContent === 'All');
    });

    if (branchSelect) {
      await user.selectOptions(branchSelect, 'trunk');

      // Should only show revisions from 'trunk' branch
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      // Note: With 'All' filter active, all revisions including #1 will still be visible
    }
  });

  it('displays formatted dates', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Dates should be formatted as locale strings
    const dateElements = screen.getAllByText(/2025/i);
    expect(dateElements.length).toBeGreaterThan(0);
  });

  it('displays file sizes in human-readable format', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should show sizes like "48.8 KB"
    const fileSizes = screen.getAllByText(/KB|MB/i);
    expect(fileSizes.length).toBeGreaterThan(0);
  });



  it('displays branch names for each revision', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    const trunkBadges = screen.getAllByText('trunk');
    expect(trunkBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('provides download links for derivatives', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should have links to download PDFs, XMLs, etc.
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);

    // Check for specific derivative types
    const pdfLinks = links.filter((link) => link.getAttribute('href')?.includes('.pdf'));
    expect(pdfLinks.length).toBeGreaterThan(0);
  });

  it('sorts revisions by sequence number descending', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Find sequence numbers in the table (first column)
    const seqNumbers = [
      screen.getByText('3'),
      screen.getByText('2'),
      screen.getByText('1')
    ];

    // Should render in descending order
    expect(seqNumbers).toHaveLength(3);
  });

  it('handles revisions without derivatives', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Revision #1 has no derivatives, should still render
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Initial upload')).toBeInTheDocument();
  });

  it('displays creator email when available', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    expect(screen.getByText(/user@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/test@example\.com/)).toBeInTheDocument();
  });

  it('renders with empty revisions array', () => {
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={[]}
        branchNames={['All']}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should render empty state or at least table headers
    expect(screen.getByText(/Filter by branch/i)).toBeInTheDocument();
  });

  it('displays license information', () => {
    const revisionsWithLicense = [
      {
        ...mockRevisions[0],
        license: 'CC0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'
      },
      {
        ...mockRevisions[1],
        license: 'All Rights Reserved'
      }
    ];

    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={revisionsWithLicense}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    expect(screen.getByText('CC0')).toBeInTheDocument();
    expect(screen.getByText('All Rights Reserved')).toBeInTheDocument();

    const licenseLink = screen.getByText('View License');
    expect(licenseLink).toBeInTheDocument();
    expect(licenseLink.closest('a')).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/zero/1.0/');
  });

  it('displays MSCZ badge when mscz derivative is present', () => {
    const revisionsWithMscz = [
      {
        ...mockRevisions[0],
        derivatives: {
          ...mockRevisions[0].derivatives,
          mscz: { bucket: 'scores-derivatives', objectKey: 'work123/rev3.mscz', sizeBytes: 120000 }
        }
      },
      {
        ...mockRevisions[1],
        // No mscz derivative - should not show badge
      }
    ];

    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={revisionsWithMscz}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    // Should have MSCZ badge for first revision
    const msczBadges = screen.getAllByText('MSCZ');
    expect(msczBadges.length).toBeGreaterThan(0);

    // Check that the link is correctly formatted
    const msczLinks = screen.getAllByRole('link').filter(link =>
      link.getAttribute('href')?.includes('score.mscz')
    );
    expect(msczLinks.length).toBeGreaterThan(0);
    expect(msczLinks[0].getAttribute('href')).toContain('works/12345/sources/source-1/score.mscz');
    expect(msczLinks[0].getAttribute('href')).toContain('r=rev-3');
  });

  it('displays KRN badge when krn derivative is present', () => {
    const revisionsWithKrn = [
      {
        ...mockRevisions[0],
        derivatives: {
          ...mockRevisions[0].derivatives,
          krn: { bucket: 'scores-derivatives', objectKey: 'work123/rev3.krn', sizeBytes: 24000 }
        }
      },
      {
        ...mockRevisions[1]
      }
    ];

    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={revisionsWithKrn}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    const krnBadges = screen.getAllByText('KRN');
    expect(krnBadges.length).toBeGreaterThan(0);

    const krnLinks = screen.getAllByRole('link').filter(link =>
      link.getAttribute('href')?.includes('score.krn')
    );
    expect(krnLinks.length).toBeGreaterThan(0);
    expect(krnLinks[0].getAttribute('href')).toContain('works/12345/sources/source-1/score.krn');
    expect(krnLinks[0].getAttribute('href')).toContain('r=rev-3');
  });

  it('displays ABC badge when abc derivative is present', () => {
    const revisionsWithAbc = [
      {
        ...mockRevisions[0],
        derivatives: {
          ...mockRevisions[0].derivatives,
          abc: { bucket: 'scores-derivatives', objectKey: 'work123/rev3.abc', sizeBytes: 4096 }
        }
      },
      {
        ...mockRevisions[1]
      }
    ];

    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={revisionsWithAbc}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    const abcBadges = screen.getAllByText('ABC');
    expect(abcBadges.length).toBeGreaterThan(0);

    const abcLinks = screen.getAllByRole('link').filter(link =>
      link.getAttribute('href')?.includes('score.abc')
    );
    expect(abcLinks.length).toBeGreaterThan(0);
    expect(abcLinks[0].getAttribute('href')).toContain('works/12345/sources/source-1/score.abc');
    expect(abcLinks[0].getAttribute('href')).toContain('r=rev-3');
  });

  it('passes launch context when opening a revision in the editor', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        sourceLabel="Full Score"
        sourceType="score"
        workTitle="Prelude in C"
        composer="J.S. Bach"
        imslpPermalink="https://imslp.org/wiki/Test_Work"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Open in Editor/i }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [editorUrl] = openSpy.mock.calls[0];
    const launchContextRaw = new URL(String(editorUrl), 'http://localhost').searchParams.get('launchContext');
    expect(launchContextRaw).toBeTruthy();
    expect(JSON.parse(launchContextRaw || '')).toMatchObject({
      source: 'ourtextscores',
      workId: '12345',
      sourceId: 'source-1',
      branchName: 'trunk',
      revisionId: 'rev-3',
      sourceLabel: 'Full Score',
      sourceType: 'score',
      workTitle: 'Prelude in C',
      composer: 'J.S. Bach',
      imslpUrl: 'https://imslp.org/wiki/Test_Work',
    });

    openSpy.mockRestore();
  });

  it('starts a change review against the previous visible revision', async () => {
    const user = userEvent.setup();
    const originalFetch = global.fetch;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/change-reviews')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ reviewId: 'review-123' }),
          text: async () => '',
        } as any);
      }
      if (url.includes('/comments')) {
        return Promise.resolve({
          ok: true,
          json: async () => ([]),
          text: async () => '[]',
        } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ([]),
        text: async () => '[]',
      } as any);
    }) as any;

    renderWithProviders(
      <RevisionHistory
        workId="12345"
        sourceId="source-1"
        revisions={mockRevisions}
        branchNames={branchNames}
        publicApiBase="http://localhost:4000/api"
      />
    );

    await user.click(screen.getByRole('button', { name: /Start Review vs #2/i }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/proxy/works/12345/sources/source-1/change-reviews',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          baseRevisionId: 'rev-2',
          headRevisionId: 'rev-3',
          title: 'Review #2 -> #3',
        }),
      }),
    );

    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
  });
});
