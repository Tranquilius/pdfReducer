// pdf.js ships these as .mjs; they are renamed to .js here because GitHub Pages
// has served .mjs as application/octet-stream, which browsers reject for modules.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.js';
import { PdfBuilder, encodeImage } from './pdfwriter.js';
import { toGray8, grayToRgba, rgbaToRgb8, toBilevel } from './imaging.js';

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
  mode: $('mode'), modeHint: $('modeHint'),
  dpi: $('dpi'), dpiOut: $('dpiOut'),
  quality: $('quality'), qualityOut: $('qualityOut'), qualityRow: $('qualityRow'),
  maxDim: $('maxDim'),
  target: $('target'), targetSize: $('targetSize'),
  estimateRow: $('estimateRow'), estimate: $('estimate'), estimateNote: $('estimateNote'),
  go: $('go'), cancel: $('cancel'),
  progressWrap: $('progressWrap'), bar: $('bar'), status: $('status'),
  result: $('result'), sizeBefore: $('sizeBefore'), sizeAfter: $('sizeAfter'),
  sizeDelta: $('sizeDelta'), settled: $('settled'),
  download: $('download'), warn: $('warn'),
  qualityDialog: $('qualityDialog'), qualityDpi: $('qualityDpi'),
  qualityConfirm: $('qualityConfirm'), qualityCancel: $('qualityCancel'),
};

/** Below this, rasterised text starts to lose legibility no matter the mode. */
const LOW_DPI = 100;

const MODE_HINTS = {
  bw: 'Best for scanned text. Stores each page as 1 bit per pixel — typically 10–40× smaller than a photo of the same page. Colour and shading are discarded.',
  gray: 'Drops colour, keeps shading. Good for scans with photos or diagrams in them.',
  color: 'Full colour JPEG. Use when the colours carry meaning.',
  lossless: 'No quality loss at the chosen resolution, and much larger files. Rarely worth it.',
};

let selectedFile = null;
let openDoc = null;        // kept open so the live estimate can sample pages cheaply
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

async function selectFile(file) {
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('That does not look like a PDF.');
    return;
  }
  selectedFile = file;
  el.fileName.textContent = file.name;
  el.fileMeta.textContent = formatBytes(file.size);
  el.fileinfo.hidden = false;
  el.result.hidden = true;
  el.progressWrap.hidden = true;
  el.go.disabled = true;

  if (openDoc) { await openDoc.destroy().catch(() => {}); openDoc = null; }
  cancelled = false;

  try {
    openDoc = await openPdf(new Uint8Array(await file.arrayBuffer()));
    el.fileMeta.textContent = `${formatBytes(file.size)} · ${openDoc.numPages} page${openDoc.numPages === 1 ? '' : 's'}`;
    el.go.disabled = false;
    el.estimateRow.hidden = false;
    refreshEstimate();
  } catch (err) {
    el.estimateRow.hidden = true;
    if (!cancelled) {
      console.error(err);
      el.fileMeta.textContent = `${formatBytes(file.size)} · could not be opened`;
    }
  }
}

/* ---------- controls ---------- */

const sync = (input, output) => {
  const update = () => { output.textContent = input.value; };
  input.addEventListener('input', update);
  update();
};
sync(el.dpi, el.dpiOut);
sync(el.quality, el.qualityOut);

function refreshMode() {
  const mode = el.mode.value;
  el.modeHint.textContent = MODE_HINTS[mode];
  el.qualityRow.hidden = mode === 'bw' || mode === 'lossless';
}
el.mode.addEventListener('change', refreshMode);
refreshMode();

const refreshTarget = () => { el.targetSize.disabled = !el.target.checked; };
el.target.addEventListener('change', refreshTarget);
refreshTarget();

function currentSettings() {
  return {
    dpi: Number(el.dpi.value),
    quality: Number(el.quality.value),
    mode: el.mode.value,
    maxDim: Number(el.maxDim.value),
  };
}

/* ---------- live size estimate ---------- */

let estimateSeq = 0;
let estimateTask = null;   // in-flight pdf.js render, cancelled when superseded
let estimateTimer = null;

/**
 * Prices one sample page at the current settings and scales it by the page
 * count. Dragging the slider fires continuously, so this is debounced and the
 * superseded render is cancelled rather than left to finish unwanted.
 */
async function refreshEstimate() {
  if (!openDoc || running) return;
  const seq = ++estimateSeq;

  try { estimateTask?.cancel(); } catch { /* already settled */ }
  el.estimateRow.classList.add('busy');
  el.estimateNote.textContent = 'estimating…';

  const settings = currentSettings();
  try {
    // Two samples on anything longer than a couple of pages: one page is a
    // noisy predictor of the whole document, and the second roughly halves the
    // error for one extra page render.
    const samples = samplePages(openDoc, openDoc.numPages >= 3 ? 2 : 1);
    const bytes = await estimateSize(openDoc, settings, samples, (task) => { estimateTask = task; });
    if (seq !== estimateSeq) return;

    el.estimate.textContent = `≈ ${formatBytes(bytes)}`;
    const delta = bytes / selectedFile.size;
    el.estimateNote.textContent =
      `${delta < 1 ? `${(1 / delta).toFixed(1)}× smaller` : `${delta.toFixed(1)}× larger`} · ` +
      `from ${samples.length} sampled page${samples.length === 1 ? '' : 's'}`;
  } catch (err) {
    if (seq !== estimateSeq) return;   // cancelled by a newer request; ignore
    el.estimate.textContent = '—';
    el.estimateNote.textContent = 'could not estimate';
  } finally {
    if (seq === estimateSeq) el.estimateRow.classList.remove('busy');
  }
}

const scheduleEstimate = () => {
  if (!openDoc || running) return;
  // Mark stale immediately: during the debounce the displayed figure belongs to
  // the previous settings, and showing it as current would be a lie.
  estimateSeq++;
  el.estimateRow.classList.add('busy');
  el.estimateNote.textContent = 'estimating…';
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(refreshEstimate, 220);
};

for (const input of [el.dpi, el.quality]) input.addEventListener('input', scheduleEstimate);
for (const input of [el.mode, el.maxDim]) input.addEventListener('change', scheduleEstimate);

el.cancel.addEventListener('click', () => {
  cancelled = true;
  el.cancel.disabled = true;
  el.status.textContent = 'Cancelling…';
});

el.go.addEventListener('click', () => { if (!running) run(); });

/* ---------- low-resolution download warning ---------- */

// Set when the delivered PDF was rendered below LOW_DPI, whether the user chose
// that resolution or the size-target search settled on it. Cleared once
// acknowledged, so confirming does not re-prompt for the same result.
let warnBeforeDownload = false;

el.download.addEventListener('click', (e) => {
  if (!warnBeforeDownload) return;
  e.preventDefault();
  el.qualityDialog.showModal();
});

el.qualityConfirm.addEventListener('click', () => {
  el.qualityDialog.close();
  warnBeforeDownload = false;
  el.download.click();
});

el.qualityCancel.addEventListener('click', () => el.qualityDialog.close());

/* ---------- main pipeline ---------- */

async function run() {
  running = true;
  cancelled = false;
  el.go.disabled = true;
  el.cancel.hidden = false;
  el.cancel.disabled = false;
  el.result.hidden = true;
  el.progressWrap.hidden = false;
  setProgress(0, 'Starting…');

  const mode = el.mode.value;
  const targetBytes = el.target.checked ? Number(el.targetSize.value) * 1024 * 1024 : null;

  try {
    // Invalidate any pending estimate so its result cannot paint over the run.
    estimateSeq++;
    clearTimeout(estimateTimer);
    try { estimateTask?.cancel(); } catch { /* already settled */ }
    const pdf = openDoc;
    if (!pdf) throw new Error('No PDF is open.');

    let settings = currentSettings();
    if (targetBytes) settings = await chooseSettings(pdf, settings, targetBytes);
    if (cancelled) { setProgress(0, 'Cancelled.'); return; }

    let blob = await renderDocument(pdf, settings, '');
    if (cancelled) { setProgress(0, 'Cancelled.'); return; }

    // The estimate is extrapolated from sample pages, so it can land just over
    // on documents whose pages vary a lot. One corrective pass, then report.
    if (targetBytes && blob.size > targetBytes) {
      const retry = { ...settings, quality: Math.max(12, Math.round(settings.quality * 0.7)) };
      if (mode === 'bw' || mode === 'lossless') retry.dpi = Math.max(50, Math.round(settings.dpi * 0.75));
      setProgress(0, 'Slightly over target — one more pass…');
      const second = await renderDocument(pdf, retry, 'Final pass · ');
      if (!cancelled && second.size < blob.size) { blob = second; settings = retry; }
    }

    if (cancelled) { setProgress(0, 'Cancelled.'); return; }

    showResult(blob, settings, targetBytes);
    el.progressWrap.hidden = true;
  } catch (err) {
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
    refreshEstimate();
  }
}

function openPdf(data) {
  const task = pdfjsLib.getDocument({ data, ...PDFJS_ASSETS });
  task.onPassword = (callback, reason) => {
    const label = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? 'Incorrect password. Try again:'
      : 'This PDF is password protected. Enter the password:';
    const pw = window.prompt(label);
    if (pw === null) { cancelled = true; task.destroy(); } else { callback(pw); }
  };
  return task.promise;
}

/**
 * Picks the highest-quality settings expected to fit the size target.
 *
 * Rather than re-rendering the whole document per guess, this prices a couple
 * of sample pages and extrapolates. Quality is searched first because dropping
 * resolution hurts legibility faster than JPEG quality does; only when the
 * lowest quality still cannot fit does it step the resolution down.
 */
async function chooseSettings(pdf, base, targetBytes) {
  const samples = samplePages(pdf, 2);
  const budget = targetBytes * 0.92;   // headroom for page objects and variance
  const estimate = (settings) => (cancelled ? Infinity : estimateSize(pdf, settings, samples));

  const qualityFixed = base.mode === 'bw' || base.mode === 'lossless';
  const dpiSteps = [1, 0.85, 0.7, 0.55, 0.42, 0.3];

  let step = 0;
  for (const factor of dpiSteps) {
    const dpi = Math.max(50, Math.round(base.dpi * factor));
    setProgress(step / dpiSteps.length, `Estimating best settings for the size limit (${dpi} DPI)…`);
    step++;

    if (qualityFixed) {
      if (await estimate({ ...base, dpi }) <= budget) return { ...base, dpi };
      continue;
    }

    // Highest quality that fits, by binary search over the quality scale.
    let lo = 12;
    let hi = base.quality;
    if (await estimate({ ...base, dpi, quality: lo }) > budget) continue;
    while (lo < hi) {
      if (cancelled) return { ...base, dpi, quality: lo };
      const mid = Math.ceil((lo + hi) / 2);
      if (await estimate({ ...base, dpi, quality: mid }) <= budget) lo = mid; else hi = mid - 1;
    }
    return { ...base, dpi, quality: lo };
  }

  // Nothing fits; hand back the most aggressive settings and let the caller
  // report the shortfall honestly.
  return { ...base, dpi: Math.max(50, Math.round(base.dpi * 0.3)), quality: qualityFixed ? base.quality : 12 };
}

/** Evenly spaced page numbers to sample; a middle page beats a cover page. */
function samplePages(pdf, count) {
  const total = pdf.numPages;
  const k = Math.min(count, total);
  if (k === 1) return [Math.ceil(total / 2)];
  return Array.from({ length: k }, (_, i) => Math.max(1, Math.min(total, Math.round(((i + 0.5) * total) / k))));
}

/** Extrapolates whole-document size from sample pages, in final compressed bytes. */
async function estimateSize(pdf, settings, samples, onRenderTask) {
  let sum = 0;
  for (const n of samples) {
    const { image } = await renderOnePage(pdf, n, settings, undefined, onRenderTask);
    const { data } = await encodeImage(image);
    sum += data.length + 400;   // page, content and image dictionaries
  }
  return (sum / samples.length) * pdf.numPages + 300;
}

async function renderOnePage(pdf, n, { dpi, quality, mode, maxDim }, canvas = document.createElement('canvas'), onRenderTask) {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: mode !== 'color' });
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
  const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' });
  onRenderTask?.(task);
  await task.promise;
  page.cleanup();

  return { base, image: await encodePage(canvas, ctx, mode, quality) };
}

async function renderDocument(pdf, settings, label) {
  const total = pdf.numPages;
  const builder = new PdfBuilder();
  const canvas = document.createElement('canvas');

  for (let n = 1; n <= total; n++) {
    if (cancelled) break;
    setProgress((n - 1) / total, `${label}Rendering page ${n} of ${total}…`);
    await nextFrame();
    const { base, image } = await renderOnePage(pdf, n, settings, canvas);
    builder.addPage(base.width, base.height, image);
  }

  return builder.build();
}

async function encodePage(canvas, ctx, mode, quality) {
  const { width, height } = canvas;

  if (mode === 'color') {
    return { kind: 'jpeg', width, height, data: await encodeJpeg(canvas, quality) };
  }

  const img = ctx.getImageData(0, 0, width, height);

  if (mode === 'lossless') {
    return { kind: 'rgb8', width, height, data: rgbaToRgb8(img.data, width, height) };
  }

  const gray = toGray8(img.data, width, height);

  if (mode === 'bw') {
    return { kind: 'gray1', width, height, data: toBilevel(gray, width, height).data };
  }

  // Grayscale: a desaturated JPEG still beats raw 8-bit grey on photographic
  // content, so keep DCT rather than storing gray8 directly.
  grayToRgba(gray, img.data);
  ctx.putImageData(img, 0, 0);
  return { kind: 'jpeg', width, height, data: await encodeJpeg(canvas, quality) };
}

function encodeJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error('Could not encode the page image.')); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      quality / 100,
    );
  });
}

function showResult(blob, used, targetBytes) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);

  const before = selectedFile.size;
  const after = blob.size;
  const pct = ((after - before) / before) * 100;

  el.sizeBefore.textContent = formatBytes(before);
  el.sizeAfter.textContent = formatBytes(after);
  el.sizeDelta.textContent = (pct <= 0 ? '−' : '+') + Math.abs(pct).toFixed(1) + '%';

  const modeLabel = el.mode.options[el.mode.selectedIndex].text;
  el.settled.textContent = el.qualityRow.hidden
    ? `${modeLabel} · ${used.dpi} DPI`
    : `${modeLabel} · ${used.dpi} DPI · quality ${used.quality}`;

  el.download.href = lastUrl;
  el.download.download = selectedFile.name.replace(/\.pdf$/i, '') + '-reduced.pdf';

  warnBeforeDownload = used.dpi < LOW_DPI;
  el.qualityDpi.textContent = `${used.dpi} DPI`;

  let warning = null;
  if (targetBytes && after > targetBytes) {
    warning = `Could not reach ${formatBytes(targetBytes)} even at the lowest settings. ` +
      'Try black & white mode, or a lower starting resolution.';
  } else if (after >= before) {
    warning = 'The result is larger than the original — this PDF was already well compressed. ' +
      'Try a lower resolution, or keep the original.';
  }
  el.warn.textContent = warning ?? '';
  el.warn.hidden = !warning;
  el.result.hidden = false;
}

/* ---------- helpers ---------- */

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
