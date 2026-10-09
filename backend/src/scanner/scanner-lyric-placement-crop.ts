import { NoteChoice } from './scanner-lyric-note-choices';

export interface PlacementCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The rectangle (page raster px) showing a row, its staff and every offered note. */
export function placementCropRect(
  row: number[],
  staff: number[],
  choices: NoteChoice[],
  image: { width: number; height: number }
): PlacementCrop {
  const xs = [row[0], row[2], ...choices.map((c) => c.x)];
  const left = Math.max(0, Math.floor(Math.min(...xs) - 50));
  const right = Math.min(image.width, Math.ceil(Math.max(...xs) + 50));
  const top = Math.max(0, Math.floor(Math.min(staff[1], row[1]) - 45));
  const bottom = Math.min(image.height, Math.ceil(Math.max(staff[3], row[3]) + 25));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** SVG overlay in crop coordinates: the row (orange) and a numbered line per offered note. */
export function placementOverlaySvg(
  crop: PlacementCrop,
  row: number[],
  staff: number[],
  choices: NoteChoice[],
  proposedIds: Set<string>
): string {
  const lines = choices
    .map((c) => {
      const x = (c.x - crop.left).toFixed(1);
      const proposed = proposedIds.has(c.noteId);
      const colour = proposed ? '#1766ce' : '#6b7280';
      const top = (staff[1] - crop.top).toFixed(1);
      const bottom = (staff[3] - crop.top).toFixed(1);
      const labelY = Math.max(12, staff[1] - crop.top - 14).toFixed(1);
      return (
        `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${colour}" stroke-width="${proposed ? 3 : 1.5}" stroke-opacity="${proposed ? 1 : 0.7}"/>` +
        `<circle cx="${x}" cy="${labelY}" r="11" fill="${proposed ? '#1766ce' : '#ffffff'}" stroke="${colour}" stroke-width="1.5"/>` +
        `<text x="${x}" y="${(Number(labelY) + 4.5).toFixed(1)}" font-family="sans-serif" font-size="13" font-weight="700" text-anchor="middle" fill="${proposed ? '#ffffff' : '#374151'}">${c.number}</text>`
      );
    })
    .join('');
  const box =
    `<rect x="${(row[0] - crop.left).toFixed(1)}" y="${(row[1] - crop.top).toFixed(1)}" ` +
    `width="${(row[2] - row[0]).toFixed(1)}" height="${(row[3] - row[1]).toFixed(1)}" fill="none" stroke="#ca6c10" stroke-width="3"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}">${box}${lines}</svg>`;
}
