// pdf.js ships these as .mjs; they are renamed to .js here because GitHub Pages
// has served .mjs as application/octet-stream, which browsers reject for modules.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.js';

const PDFJS_ASSETS = {
  cMapUrl: './vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
};

const $ = (id) => document.getElementById(id);
const el = {
  drop: $('drop'), file: $('file'),
  fileinfo: $('fileinfo'), fileName: $('fileName'), fileMeta: $('fileMeta'),
  dpi: $('dpi'), dpiOut: $('dpiOut'),
  quality: $('quality'), qualityOut: $('qualityOut'),
  format: $('format'), maxDim: $('maxDim'), grayscale: $('grayscale'),
  go: $('go'), cancel: $('cancel'),
  progressWrap: $('progressWrap'), bar: $('bar'), status: $('status'),
  result: $('result'), sizeBefore: $('sizeBefore'), sizeAfter: $('sizeAfter'),
  sizeDelta: $('sizeDelta'), download: $('download'), warn: $('warn'),
};

let selectedFile = null;
let lastUrl = null;
let cancelled = false;
let running = false;

/* ---------- file selection ---------- */

el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
});
el.file.addEventListener('change', () => {
  if (el.file.files[0]) selectFile(el.file.files[0]);
});

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.remove('over'); });
}
el.drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) selectFile(f);
});

function selectFile(file) {
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('That does not look like a PDF.');
    return;
  }
  selectedFile = file;
  el.fileName.textContent = file.name;
  el.fileMeta.textContent = formatBytes(file.size);
  el.fileinfo.hidden = false;
  el.go.disabled = false;
  el.result.hidden = true;
  el.progressWrap.hidden = true;
}

/* ---------- controls ---------- */

const sync = (input, output) => {
  const update = () => { output.textContent = input.value; };
  input.addEventListener('input', update);
  update();
};
sync(el.dpi, el.dpiOut);
sync(el.quality, el.qualityOut);

el.format.addEventListener('change', () => {
  const isPng = el.format.value === 'image/png';
  el.quality.disabled = isPng;
  el.quality.closest('.row').style.opacity = isPng ? 0.5 : 1;
});

el.cancel.addEventListener('click', () => {
  cancelled = true;
  el.cancel.disabled = true;
  el.status.textContent = 'Cancelling…';
});

el.go.addEventListener('click', () => { if (!running) run(); });

/* ---------- main pipeline ---------- */

async function run() {
  running = true;
  cancelled = false;
  el.go.disabled = true;
  el.cancel.hidden = false;
  el.cancel.disabled = false;
  el.result.hidden = true;
  el.progressWrap.hidden = false;
  setProgress(0, 'Reading file…');

  const dpi = Number(el.dpi.value);
  const quality = Number(el.quality.value) / 100;
  const mime = el.format.value;
  const maxDim = Number(el.maxDim.value);
  const gray = el.grayscale.checked;
  const jsPdfFormat = mime === 'image/png' ? 'PNG' : 'JPEG';

  let doc = null;
  try {
    const data = new Uint8Array(await selectedFile.arrayBuffer());
    const task = pdfjsLib.getDocument({ data, ...PDFJS_ASSETS });
    task.onPassword = (callback, reason) => {
      const label = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? 'Incorrect password. Try again:'
        : 'This PDF is password protected. Enter the password:';
      const pw = window.prompt(label);
      if (pw === null) { cancelled = true; task.destroy(); } else { callback(pw); }
    };

    const pdf = await task.promise;
    const total = pdf.numPages;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: gray });

    for (let n = 1; n <= total; n++) {
      if (cancelled) break;
      setProgress((n - 1) / total, `Rendering page ${n} of ${total}…`);
      await nextFrame();

      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });          // page size in PDF points
      const longEdge = Math.max(base.width, base.height);
      const scale = Math.min(dpi / 72, maxDim / longEdge);
      const viewport = page.getViewport({ scale });

      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      // JPEG has no alpha channel, so transparent areas would turn black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      page.cleanup();

      if (gray) toGrayscale(ctx, canvas.width, canvas.height);

      const bytes = await encode(canvas, mime, quality);

      if (!doc) {
        doc = new window.jspdf.jsPDF({
          unit: 'pt',
          format: [base.width, base.height],
          orientation: base.width > base.height ? 'landscape' : 'portrait',
          compress: true,
        });
      } else {
        doc.addPage([base.width, base.height], base.width > base.height ? 'landscape' : 'portrait');
      }
      doc.addImage(bytes, jsPdfFormat, 0, 0, base.width, base.height, undefined, 'FAST');
    }

    await pdf.destroy();

    if (cancelled) {
      setProgress(0, 'Cancelled.');
      return;
    }

    setProgress(1, 'Writing PDF…');
    await nextFrame();
    const blob = doc.output('blob');
    showResult(blob);
    el.progressWrap.hidden = true;
  } catch (err) {
    // Cancelling at the password prompt tears down the loading task, which
    // surfaces here as a rejection rather than a real failure.
    if (cancelled) {
      setProgress(0, 'Cancelled.');
    } else {
      console.error(err);
      setProgress(0, `Failed: ${err?.message || err}`);
    }
  } finally {
    running = false;
    el.go.disabled = false;
    el.cancel.hidden = true;
  }
}

function showResult(blob) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);

  const before = selectedFile.size;
  const after = blob.size;
  const pct = ((after - before) / before) * 100;

  el.sizeBefore.textContent = formatBytes(before);
  el.sizeAfter.textContent = formatBytes(after);
  el.sizeDelta.textContent = (pct <= 0 ? '−' : '+') + Math.abs(pct).toFixed(1) + '%';

  el.download.href = lastUrl;
  el.download.download = selectedFile.name.replace(/\.pdf$/i, '') + '-reduced.pdf';

  el.warn.hidden = after < before;
  if (after >= before) {
    el.warn.textContent =
      'The result is larger than the original — this PDF was already well compressed. ' +
      'Try a lower DPI or JPEG quality, or keep the original.';
  }
  el.result.hidden = false;
}

/* ---------- helpers ---------- */

function encode(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error('Could not encode the page image.')); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      mime,
      quality,
    );
  });
}

function toGrayscale(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function setProgress(fraction, text) {
  el.bar.style.width = `${Math.round(fraction * 100)}%`;
  el.status.textContent = text;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
