// Where the overlay opens. Pure, no Electron imports.
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const OVERLAY_SIZE = { width: 560, height: 340 }

/** Saved bounds if their header is still on a connected display; otherwise top-center of `workArea`
 *  (the display with the cursor), 12 px under the menu bar. */
export function overlayBounds(saved: Rect | null, displays: Rect[], workArea: Rect): Rect {
  if (saved) {
    const cx = saved.x + saved.width / 2
    const cy = saved.y + 14 // middle of the 28 px drag header
    const visible = displays.some(
      (d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height
    )
    if (visible) return saved
  }
  return {
    ...OVERLAY_SIZE,
    x: Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2),
    y: workArea.y + 12
  }
}
