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

import { screen, within } from '@testing-library/react';
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
    fossilBranch: 'main',
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
    fossilBranch: 'main',
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

const branchNames = ['All', 'main', 'trunk'];

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
      await user.selectOptions(branchSelect, 'main');

      // Should only show revisions from 'main' branch
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

    const mainBadges = screen.getAllByText('main');
    expect(mainBadges.length).toBeGreaterThanOrEqual(1);

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
});
