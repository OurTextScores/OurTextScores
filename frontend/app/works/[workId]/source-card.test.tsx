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

import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils';
import SourceCard from './source-card';
import { SourceView } from '../../lib/api';

const mockSource: SourceView = {
    sourceId: 'source-1',
    label: 'Full Score',
    sourceType: 'score',
    format: 'MusicXML',
    originalFilename: 'symphony.mxl',
    isPrimary: true,
    storage: {
        bucket: 'scores',
        objectKey: 'work123/source1.mxl',
        sizeBytes: 1024,
        contentType: 'application/vnd.recordare.musicxml+xml',
        lastModifiedAt: '2025-11-01T10:00:00Z',
        checksum: { algorithm: 'sha256', hexDigest: 'abc' }
    },
    validation: { status: 'passed', issues: [] },
    provenance: {
        ingestType: 'manual',
        uploadedByUserId: 'user-1',
        uploadedAt: '2025-11-01T10:00:00Z',
        notes: []
    },
    revisions: [
        {
            revisionId: 'rev-1',
            sequenceNumber: 1,
            createdAt: '2025-11-01T10:00:00Z',
            createdBy: 'user-1',
            rawStorage: {
                bucket: 'scores',
                objectKey: 'work123/source1.mxl',
                sizeBytes: 1024,
                contentType: 'application/vnd.recordare.musicxml+xml',
                lastModifiedAt: '2025-11-01T10:00:00Z',
                checksum: { algorithm: 'sha256', hexDigest: 'abc' }
            },
            checksum: { algorithm: 'sha256', hexDigest: 'abc' },
            validation: { status: 'passed', issues: [] },
            fossilParentArtifactIds: []
        }
    ]
};

const mockUser = {
    userId: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    roles: []
};

describe('SourceCard', () => {
    it('renders source details', () => {
        renderWithProviders(
            <SourceCard
                source={mockSource}
                workId="work-123"
                currentUser={mockUser}
                watchControlsSlot={<div data-testid="watch-controls">Watch Controls</div>}
                branchesPanelSlot={<div data-testid="branches-panel">Branches Panel</div>}
            />
        );

        expect(screen.getByText('Full Score')).toBeInTheDocument();
        expect(screen.getByText('(score, MusicXML)')).toBeInTheDocument();
        expect(screen.getByText('Primary')).toBeInTheDocument();
    });

    it('renders slots correctly', () => {
        renderWithProviders(
            <SourceCard
                source={mockSource}
                workId="work-123"
                currentUser={mockUser}
                watchControlsSlot={<div data-testid="watch-controls">Watch Controls</div>}
                branchesPanelSlot={<div data-testid="branches-panel">Branches Panel</div>}
            />
        );

        expect(screen.getByTestId('watch-controls')).toBeInTheDocument();
        // Branches panel is inside the collapsible content, which is open by default
        expect(screen.getByTestId('branches-panel')).toBeInTheDocument();
    });

    it('toggles content visibility on header click', () => {
        renderWithProviders(
            <SourceCard
                source={mockSource}
                workId="work-123"
                currentUser={mockUser}
                watchControlsSlot={<div>Watch</div>}
                branchesPanelSlot={<div>Branches</div>}
            />
        );

        // Initially open
        expect(screen.getByTestId('source-card-body')).toBeInTheDocument();

        // Click header to collapse
        // The click handler is on the div wrapping the header content
        const header = screen.getByText('Full Score').closest('div')?.parentElement;
        if (header) {
            fireEvent.click(header);
        } else {
            throw new Error("Header not found");
        }

        // Should be collapsed (content removed from DOM)
        expect(screen.queryByTestId('source-card-body')).not.toBeInTheDocument();

        // Click again to expand
        if (header) {
            fireEvent.click(header);
        }

        // Should be visible again
        expect(screen.getByTestId('source-card-body')).toBeInTheDocument();
    });

    it('shows original filename when open', () => {
        renderWithProviders(
            <SourceCard
                source={mockSource}
                workId="work-123"
                currentUser={mockUser}
                watchControlsSlot={<div>Watch</div>}
                branchesPanelSlot={<div>Branches</div>}
            />
        );

        expect(screen.getByText(/Original filename:/)).toBeInTheDocument();
        expect(screen.getByText(/symphony\.mxl/)).toBeInTheDocument();
    });
});
