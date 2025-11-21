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

// Mock environment variable BEFORE imports
// process.env.NEXT_PUBLIC_MINIO_PUBLIC_URL = 'http://localhost:9000';

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

        // Expand to see branches panel
        const header = screen.getByText('Full Score').closest('div')?.parentElement;
        if (header) {
            fireEvent.click(header);
        }

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

        // Initially closed
        expect(screen.queryByTestId('source-card-body')).not.toBeInTheDocument();

        // Click header to expand
        // The click handler is on the div wrapping the header content
        const header = screen.getByText('Full Score').closest('div')?.parentElement;
        if (header) {
            fireEvent.click(header);
        } else {
            throw new Error("Header not found");
        }

        // Should be visible
        expect(screen.getByTestId('source-card-body')).toBeInTheDocument();

        // Click again to collapse
        if (header) {
            fireEvent.click(header);
        }

        // Should be collapsed again
        expect(screen.queryByTestId('source-card-body')).not.toBeInTheDocument();
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

        // Expand first
        const header = screen.getByText('Full Score').closest('div')?.parentElement;
        if (header) {
            fireEvent.click(header);
        }

        const filename = screen.getByText(/Original filename:/i);
        expect(filename).toBeInTheDocument();
        expect(filename).toHaveTextContent('symphony.mxl');
    });

    it('renders thumbnail when available', () => {
        const sourceWithThumbnail = {
            ...mockSource,
            derivatives: {
                ...mockSource.derivatives,
                thumbnail: {
                    bucket: 'derivs',
                    objectKey: 'thumb.png',
                    sizeBytes: 1024,
                    contentType: 'image/png',
                    checksum: { algorithm: 'sha256', hexDigest: 'abc' },
                    lastModifiedAt: '2025-11-01T10:00:00Z'
                }
            }
        };

        renderWithProviders(
            <SourceCard
                source={sourceWithThumbnail}
                workId="work-123"
                currentUser={mockUser}
                watchControlsSlot={<div>Watch</div>}
                branchesPanelSlot={<div>Branches</div>}
            />
        );

        // Check that thumbnail container is rendered when thumbnail data exists
        const thumbnailContainer = document.querySelector('.h-20.w-14.shrink-0');
        expect(thumbnailContainer).toBeInTheDocument();

        if (thumbnailContainer) {
            const img = thumbnailContainer.querySelector('img');
            expect(img).toBeInTheDocument();
            expect(img).toHaveAttribute('alt', `Thumbnail for ${mockSource.label}`);
            // Should use API URL now
            expect(img?.src).toContain('/api/works/work-123/sources/source-1/thumbnail.png');
        }
    });
});
