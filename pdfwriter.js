// Minimal PDF writer for single-image pages.
//
// This exists instead of a general PDF library because the compression wins
// live at the PDF level: a bilevel scan wants to be 1-bit-per-pixel data behind
// FlateDecode, not a JPEG photograph of some text. Generic libraries only take
// JPEG or PNG through their image APIs, which rules that out.

const ascii = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));

/** zlib-wrapped deflate, which is what PDF's FlateDecode expects. */
export async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PNG "Up" row prediction. Scanned pages repeat heavily down the page, so
 * differencing against the row above gives deflate much longer runs to chew on.
 * Operates on raw bytes, which is what PDF's Predictor does for sub-byte depths.
 */
export function applyUpPredictor(data, rowBytes) {
  const rows = data.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const src = r * rowBytes;
    const dst = r * (rowBytes + 1);
    out[dst] = 2; // filter type: Up
    for (let i = 0; i < rowBytes; i++) out[dst + 1 + i] = (data[src + i] - prev[i]) & 0xff;
    prev = data.subarray(src, src + rowBytes);
  }
  return out;
}

export class PdfBuilder {
  constructor() {
    this.pages = [];
  }

  /**
   * image: { kind, width, height, data, ... }
   *   kind 'jpeg'  — data is a JPEG bitstream, embedded as-is via DCTDecode
   *   kind 'gray1' — data is 1bpp packed rows (1 = white), FlateDecode
   *   kind 'gray8' — data is 8bpc grayscale, FlateDecode
   *   kind 'rgb8'  — data is 8bpc RGB, FlateDecode
   */
  addPage(widthPt, heightPt, image) {
    this.pages.push({ widthPt, heightPt, image });
  }

  async build() {
    const objects = [];   // objects[n - 1] = Uint8Array body of object n
    const put = (n, bytes) => { objects[n - 1] = bytes; };

    const pageCount = this.pages.length;
    const kids = this.pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');

    put(1, ascii('<</Type/Catalog/Pages 2 0 R>>'));
    put(2, ascii(`<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`));

    for (let i = 0; i < pageCount; i++) {
      const { widthPt, heightPt, image } = this.pages[i];
      const pageNo = 3 + i * 3;
      const contentNo = pageNo + 1;
      const imageNo = pageNo + 2;

      put(pageNo, ascii(
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${num(widthPt)} ${num(heightPt)}]` +
        `/Resources<</XObject<</Im0 ${imageNo} 0 R>>>>/Contents ${contentNo} 0 R>>`,
      ));

      // Scale the unit image square up to the full page box.
      const content = ascii(`q ${num(widthPt)} 0 0 ${num(heightPt)} 0 0 cm /Im0 Do Q\n`);
      put(contentNo, concat([ascii(`<</Length ${content.length}>>\nstream\n`), content, ascii('\nendstream')]));

      put(imageNo, await imageObject(image));
    }

    // Assemble the file, recording where each object starts for the xref table.
    const chunks = [ascii('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
    let offset = chunks[0].length;
    const offsets = [];
    for (let n = 1; n <= objects.length; n++) {
      offsets[n] = offset;
      const body = concat([ascii(`${n} 0 obj\n`), objects[n - 1], ascii('\nendobj\n')]);
      chunks.push(body);
      offset += body.length;
    }

    const count = objects.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n <= objects.length; n++) {
      xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(ascii(xref));

    return new Blob(chunks, { type: 'application/pdf' });
  }
}

/**
 * Compresses an image to its final in-file bytes. Exposed separately so the
 * size-targeting search can price a page without building a whole document.
 */
export async function encodeImage(image) {
  const { kind, width, height } = image;
  let dict;
  let data;

  if (kind === 'jpeg') {
    dict =
      `<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${image.data.length}>>`;
    data = image.data;
  } else {
    const spec = {
      gray1: { cs: 'DeviceGray', bpc: 1, colors: 1, rowBytes: (width + 7) >> 3 },
      gray8: { cs: 'DeviceGray', bpc: 8, colors: 1, rowBytes: width },
      rgb8: { cs: 'DeviceRGB', bpc: 8, colors: 3, rowBytes: width * 3 },
    }[kind];
    if (!spec) throw new Error(`unsupported image kind: ${kind}`);

    data = await deflate(applyUpPredictor(image.data, spec.rowBytes));
    dict =
      `<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
      `/ColorSpace/${spec.cs}/BitsPerComponent ${spec.bpc}/Filter/FlateDecode` +
      `/DecodeParms<</Predictor 15/Colors ${spec.colors}/BitsPerComponent ${spec.bpc}/Columns ${width}>>` +
      `/Length ${data.length}>>`;
  }

  return { dict, data };
}

async function imageObject(image) {
  const { dict, data } = await encodeImage(image);
  return concat([ascii(`${dict}\nstream\n`), data, ascii('\nendstream')]);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
