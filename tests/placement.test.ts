import { describe, expect, it } from 'vitest'
import { overlayBounds } from '../src/main/placement'

const main = { x: 0, y: 0, width: 1512, height: 982 }
const mainWork = { x: 0, y: 33, width: 1512, height: 949 } // below a 33 px menu bar

describe('overlay placement', () => {
  it('defaults to top-center, 12 px under the menu bar', () => {
    expect(overlayBounds(null, [main], mainWork)).toEqual({
      x: 476,
      y: 45,
      width: 560,
      height: 340
    })
  })
  it('keeps saved bounds on a connected display', () => {
    const saved = { x: 100, y: 200, width: 600, height: 300 }
    expect(overlayBounds(saved, [main], mainWork)).toBe(saved)
  })
  it('falls back to the default when the saved display is gone', () => {
    const external = { x: 1512, y: -200, width: 2560, height: 1440 }
    const saved = { x: 2500, y: -150, width: 560, height: 340 }
    expect(overlayBounds(saved, [main, external], mainWork)).toBe(saved)
    expect(overlayBounds(saved, [main], mainWork)).toEqual({
      x: 476,
      y: 45,
      width: 560,
      height: 340
    })
  })
})
