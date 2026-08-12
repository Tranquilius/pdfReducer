# PDF Reducer

A single-page web app that rasterises every page of a PDF at a resolution you
choose and rebuilds those images into a new, usually much smaller PDF.

Everything happens in the browser — the file never leaves your machine, and
there is no build step or backend.

## Deploy to GitHub Pages

There is nothing to build. Push the repo and point Pages at the branch:

```sh
git remote add origin git@github.com:<you>/pdfReducer.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
The app appears at `https://<you>.github.io/pdfReducer/`.

Every path in the app is relative, so it works both at a domain root and under a
repo subpath. `.nojekyll` is committed so Pages copies `vendor/` through
untouched.

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
| **Resolution (DPI)** | Render scale for each page. 150 is comfortable on screen, 200–300 for print. This is the main size/quality lever. |
| **JPEG quality** | Encoder quality, 30–100. 75 is a good default; below ~60 artefacts get visible on text. |
| **Image format** | JPEG for the smallest files, PNG when you need lossless output (much larger). |
| **Max page pixels** | Hard cap on the long edge of a rendered page, so an oversized page can't exhaust memory. Lowers the effective DPI for such pages. |
| **Grayscale** | Drops colour before encoding. Usually a solid win on scanned documents. |

The output keeps each page's original physical dimensions (in points), so
printing and page count are unchanged.

## Trade-offs

- **Text stops being text.** The result is page images, so selection, search,
  copy/paste, links, and accessibility tags are gone. That is inherent to this
  approach, not a bug.
- **It doesn't always shrink.** A PDF that is already mostly compressed images,
  or one that is pure vector text, can come out *larger*. The app tells you when
  that happens — lower the DPI or keep the original.
- **Large documents take a while** and hold the finished PDF in memory before
  the download link appears.

## Layout

```
index.html            markup and controls
app.js                render → encode → rebuild pipeline
styles.css            styling (light and dark)
serve.sh              local static server (development only)
.nojekyll             stops Pages running the files through Jekyll
vendor/pdfjs/         pdf.js 4.10.38 (legacy build, worker, cmaps, standard fonts)
vendor/jspdf/         jsPDF 2.5.2 (UMD build)
```

Vendored libraries keep the app self-contained — no CDN, no third-party requests
at runtime. Both are Apache-2.0 / MIT licensed; their licence files sit next to
them.

pdf.js ships its builds as `.mjs`, but they are renamed to `.js` here: GitHub
Pages has been known to serve `.mjs` as `application/octet-stream`, which
browsers refuse to execute as a module.
