/**
 * Geometry the map needs to know about the detail sheet.
 *
 * Selecting a pin centres the map on it, but the sheet then covers the bottom
 * half on a phone and the right half on a desktop — so the pin you just tapped
 * ended up underneath the thing that opened because of it. The map offsets the
 * camera by half the covered span instead, which puts the pin in the middle of
 * what you can actually see.
 *
 * The peek fraction lives here rather than in DetailPanel because MapView needs
 * it too, and DetailPanel is a lazy chunk — importing it from there would pull
 * the whole sheet into the map's bundle.
 */

/** Where the mobile sheet settles at its "peek" height, as a fraction of the
 *  viewport from the top. It covers everything below that. */
export const SHEET_PEEK_FRACTION = 0.44;

/**
 * How far to shift the camera, in pixels, so a point lands in the centre of the
 * *visible* map rather than the centre of the canvas. Returns [x, y] for
 * maplibre's `offset`, which applies per-call and leaves no lasting padding.
 */
export function sheetFocusOffset(container: HTMLElement): [number, number] {
  const canvas = container.getBoundingClientRect();
  if (canvas.width === 0 || canvas.height === 0) return [0, 0];

  if (window.matchMedia("(max-width: 767px)").matches) {
    // Measuring the sheet mid-slide would read wherever the animation had got
    // to, so use the height it settles at.
    const sheetTop = window.innerHeight * SHEET_PEEK_FRACTION;
    const covered = Math.max(0, Math.min(canvas.bottom - sheetTop, canvas.height));
    return [0, -covered / 2];
  }

  // Desktop: the sheet is flush to the right edge. offsetWidth is a layout
  // value, so it is right even while the panel is sliding in.
  const sheet = document.querySelector<HTMLElement>(".detail-sheet");
  const width = sheet?.offsetWidth ?? Math.min(window.innerWidth * 0.5, 720);
  const covered = Math.max(0, Math.min(width, canvas.width));
  return [-covered / 2, 0];
}
