# PDF Reducer

A single-page web app that rasterises every page of a PDF at a resolution you
choose and rebuilds those images into a new, usually much smaller PDF.

Everything happens in the browser — the file never leaves your machine, and
there is no build step or backend.

## Live

**https://tranquilius.github.io/pdfReducer/**

Note the capital **R** — GitHub Pages paths are case-sensitive, so
`/pdfreducer` will not resolve.

## Deploy

There is nothing to build; Pages serves the repo exactly as committed, from
`main` at the root. Pushing to `main` republishes:

```sh
git push
```

Every path in the app is relative, so it works both at a domain root and under a
repo subpath. `.nojekyll` is committed so Pages copies `vendor/` through
untouched, and the pdf.js builds are renamed from `.mjs` to `.js` so they are
served with a JavaScript MIME type that browsers accept for ES modules.

To publish a fork of this elsewhere:

```sh
gh repo create <name> --public --source=. --remote=origin --push
gh api -X POST repos/<you>/<name>/pages -f 'source[branch]=main' -f 'source[path]=/'
```

## Run it locally

```sh
./serve.sh          # http://localhost:8080
./serve.sh 3000     # or pick a port
```

This static server is a local convenience only — the deployed app has no
backend of any kind. It is needed because pdf.js loads its worker as an ES
module, which browsers block on `file://` URLs, so opening `index.html` straight
from the filesystem will not work.

## Controls

| Control | What it does |
| --- | --- |
| **Mode** | The biggest lever by far — see below. |
| **Resolution (DPI)** | Render scale for each page. Black & white wants 200–300 to keep letterforms clean; 120–150 is plenty for the other modes. |
| **JPEG quality** | Encoder quality, 10–100, for the colour and grayscale modes. Below about 40, artefacts get visible on text. |
| **Max page pixels** | Hard cap on the long edge of a rendered page, so an oversized page can't exhaust memory. Lowers the effective DPI for such pages. |
| **Shrink until under** | Give a size budget and it finds settings that fit, then renders once. |

Below the controls, an **estimated output size** updates as you move the
resolution slider or change mode, so you can find the size/quality balance
before committing to a full render. It renders two sample pages and scales by
the page count — expect it to land within roughly 15% of the real figure, and to
err on the high side. Documents whose pages differ a lot will estimate less
precisely.

### Modes

- **Black & white** — stores pages as 1 bit per pixel behind FlateDecode. On
  scanned text this is 10–40× smaller than a photograph of the same page, and
  it removes scanner grain and grey cast as a side effect. Thresholding is
  adaptive (Bradley–Roth), so uneven page lighting does not black out one side.
  Colour and shading are discarded.
- **Grayscale** — drops colour, keeps shading. For scans containing photos.
- **Colour** — full-colour JPEG.
- **Lossless** — no quality loss at the chosen resolution, and much larger
  files. Rarely worth it.

Measured on a 7.8 MB, 4-page 300 DPI scan:

| Mode | Setting | Output | Shrink |
| --- | --- | --- | --- |
| Black & white | 200 DPI | 188 KB | 43× |
| Black & white | 300 DPI | 391 KB | 20× |
| Grayscale | 150 DPI, q70 | 963 KB | 8× |
| Colour | 150 DPI, q40 | 532 KB | 15× |

The output keeps each page's original physical dimensions (in points), so
printing and page count are unchanged.

### How the size target works

Re-rendering a whole document per guess is slow, so the search prices one or two
sample pages, extrapolates, and binary-searches the quality scale for the best
fit — dropping resolution only when the quality floor still will not fit, since
resolution hurts legibility faster. It then renders once at the chosen settings,
with a single corrective pass if the estimate landed just over.

## Trade-offs

- **Text stops being text.** The result is page images, so selection, search,
  copy/paste, links, and accessibility tags are gone. That is inherent to this
  approach, not a bug.
- **Below 100 DPI, legibility is at risk.** Small print, footnotes and thin
  diagram lines can blur past reading. When a reduction lands below 100 DPI a
  dialog opens as soon as it finishes, carrying the result figures, the caveat
  and the download together, so the risk is seen before the file is taken. It
  fires whether you chose that resolution yourself or the size target settled
  on it, since a tight budget can drive the search well below 100 DPI on its
  own.
- **It doesn't always shrink.** A PDF that is already mostly compressed images,
  or one that is pure vector text, can come out *larger*. The app tells you when
  that happens — lower the DPI or keep the original.
- **Large documents take a while** and hold the finished PDF in memory before
  the download link appears.

## Layout

```
index.html            markup and controls
app.js                pipeline: render → encode → rebuild, and the size search
pdfwriter.js          minimal PDF writer (DCTDecode / FlateDecode image pages)
imaging.js            grayscale, adaptive thresholding, pixel packing
styles.css            styling (light and dark)
serve.sh              local static server (development only)
.nojekyll             stops Pages running the files through Jekyll
vendor/pdfjs/         pdf.js 4.10.38 (legacy build, worker, cmaps, standard fonts)
```

`pdfwriter.js` exists instead of a general PDF library because the compression
wins live at the PDF level: a bilevel scan needs to be 1-bit data behind
FlateDecode, and the image APIs of general libraries only accept JPEG or PNG.
Writing the ~150 lines directly also dropped a 357 KB dependency.

pdf.js is vendored so the app is self-contained — no CDN, no third-party
requests at runtime. It is Apache-2.0 licensed; the licence file sits next to
it.

pdf.js ships its builds as `.mjs`, but they are renamed to `.js` here: GitHub
Pages has been known to serve `.mjs` as `application/octet-stream`, which
browsers refuse to execute as a module.
