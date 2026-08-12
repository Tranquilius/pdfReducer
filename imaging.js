// Pixel work: the conversions that happen between rendering a page and
// handing bytes to the PDF writer.

/** Rec. 601 luma. */
export function toGray8(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return out;
}

export function grayToRgba(gray, rgba) {
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = gray[p];
  }
}

export function rgbaToRgb8(rgba, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
  }
  return out;
}

/**
 * Bradley–Roth adaptive threshold, packed to 1 bit per pixel (1 = white).
 *
 * A single global threshold wrecks real scans, which have uneven illumination
 * across the page — one side goes solid black while the other loses faint text.
 * This compares each pixel against the mean of its neighbourhood instead, via
 * an integral image so the window size costs nothing.
 */
export function toBilevel(gray, width, height, { window: winFrac = 1 / 16, threshold: t = 0.15 } = {}) {
  // Integral image, one row/column of zero padding so lookups need no clamping.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const s = Math.max(8, Math.round(width * winFrac));
  const half = s >> 1;
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * (width + 1) + (x2 + 1)] -
        integral[y1 * (width + 1) + (x2 + 1)] -
        integral[(y2 + 1) * (width + 1) + x1] +
        integral[y1 * (width + 1) + x1];
      // White unless the pixel sits meaningfully below its local mean.
      if (gray[y * width + x] * count > sum * (1 - t)) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { data: out, rowBytes };
}
