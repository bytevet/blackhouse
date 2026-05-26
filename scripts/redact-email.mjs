// One-shot redactor: paints a solid black rect over the agent email line in
// tmp/demo/session-browser.png. Coordinates measured against the 1440x900 image.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

const inPath = "tmp/demo/session-browser.png";
const outPath = "tmp/demo/session-browser.png";

const png = PNG.sync.read(readFileSync(inPath));
const { width, data } = png;

// Email line position (post-resize 1440x900). Slightly generous padding so we
// don't slice a glyph in half.
const rect = { x: 398, y: 138, w: 354, h: 22 };

// Use the surrounding terminal background color so the redaction blends in.
// Sample a pixel just above the email line (still inside the terminal area).
function px(x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
const [r, g, b] = px(rect.x, rect.y - 6);

for (let y = rect.y; y < rect.y + rect.h; y++) {
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
}

writeFileSync(outPath, PNG.sync.write(png));
console.log(`redacted ${rect.w}x${rect.h} at (${rect.x},${rect.y}) with bg rgb(${r},${g},${b})`);
