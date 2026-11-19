# Umbo

Umbo is a browser-based shell drawing studio. Draw on the canvas, adjust the brush and surface finish, and export a PNG.

## Run locally

From the repository root, run `python3 -m http.server 8000` and open `http://localhost:8000`. The published files are ready to serve. Open `/studio.html` to work directly with the editable source.

## Source

- `studio.html` defines the canvas and controls. `style.css` styles the studio.
- `js/studio.js` handles drawing, history, audio, and export. `js/spatial.js`, `js/weld.js`, and `js/finishes.js` handle geometry and rendering.
- `js/monitor.js` draws the orientation indicator. `js/picker.js` handles the color picker.
- `assets/` contains the interface artwork, audio, and Iosevka Etoile font. The font license is in `assets/fonts/OFL.txt`.

## Publishing

After editing the source, run `python3 tools/build.py` from the repository root with Node.js installed. The script uses a pinned esbuild release through npx, or a local esbuild executable supplied in `ESBUILD`. Commit the generated `index.html` and `js/studio.min.js` alongside the source. The published page embeds the control artwork and CSS and loads one cacheable script.

Serve the repository root with GitHub Pages from the `main` branch. `CNAME` sets the custom domain to `umbo.ink`.
