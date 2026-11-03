import { describe, it, expect } from "vitest";
import { cropGeometry, VIEW } from "./ImageCropDialog.jsx";

// Pure crop math: the frame is a square that must always be covered by the
// photo (no letterboxing), panning is clamped to the photo's edges, and the
// returned source rect maps exactly onto the frame.
describe("cropGeometry", () => {
  it("covers a square frame with a wide photo, centered", () => {
    const g = cropGeometry(1000, 500, VIEW, 1, { x: 0, y: 0 });
    // scale = max(300/1000, 300/500) = 0.6 → 600 x 300 displayed
    expect(g.dw).toBeCloseTo(600);
    expect(g.dh).toBeCloseTo(300);
    // centered horizontally: (1000 - 300/0.6) / 2 = 250
    expect(g.sx).toBeCloseTo(250);
    expect(g.sy).toBeCloseTo(0);
    expect(g.sw).toBeCloseTo(500);
    expect(g.sh).toBeCloseTo(500);
  });

  it("covers a square frame with a tall photo", () => {
    const g = cropGeometry(400, 800, VIEW, 1, { x: 0, y: 0 });
    expect(g.dw).toBeCloseTo(300);
    expect(g.dh).toBeCloseTo(600);
    expect(g.sx).toBeCloseTo(0);
    expect(g.sy).toBeCloseTo(200);
    expect(g.sw).toBeCloseTo(400);
    expect(g.sh).toBeCloseTo(400);
  });

  it("at zoom 1 a square photo has nothing to pan", () => {
    const g = cropGeometry(1000, 1000, VIEW, 1, { x: 9999, y: -9999 });
    expect(g.ox).toBe(0);
    expect(g.oy).toBe(0);
    expect(g.sx).toBeCloseTo(0);
    expect(g.sy).toBeCloseTo(0);
    expect(g.sw).toBeCloseTo(1000);
  });

  it("clamps panning to the photo edges", () => {
    const g = cropGeometry(1000, 1000, VIEW, 2, { x: 9999, y: -9999 });
    // scale 0.6 → 600 displayed → max pan 150 each way
    expect(g.ox).toBe(150);
    expect(g.oy).toBe(-150);
    // Dragging the photo right reveals its LEFT edge (sx 0); dragging it up
    // reveals the BOTTOM edge (sy 500: frame 300 display px / scale 0.6).
    expect(g.sx).toBeCloseTo(0);
    expect(g.sy).toBeCloseTo(500);
    expect(g.sw).toBeCloseTo(500);
    expect(g.sh).toBeCloseTo(500);
  });

  it("never returns a source rect outside the photo", () => {
    for (const [w, h] of [[3000, 300], [300, 3000], [100, 100], [512, 512]]) {
      for (const zoom of [1, 1.5, 3]) {
        for (const offset of [{ x: -5000, y: 5000 }, { x: 200, y: -200 }, { x: 0, y: 0 }]) {
          const g = cropGeometry(w, h, VIEW, zoom, offset);
          expect(g.sx).toBeGreaterThanOrEqual(0);
          expect(g.sy).toBeGreaterThanOrEqual(0);
          expect(g.sx + g.sw).toBeLessThanOrEqual(w + 1e-6);
          expect(g.sy + g.sh).toBeLessThanOrEqual(h + 1e-6);
          // The source maps onto the full square frame at the same scale.
          expect(g.sw).toBeCloseTo(VIEW / g.scale);
          expect(g.sh).toBeCloseTo(VIEW / g.scale);
        }
      }
    }
  });
});
