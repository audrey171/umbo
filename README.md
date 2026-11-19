# Umbo

Umbo is a browser-based shell drawing studio. Draw on the canvas, adjust the brush and surface finish, and export a PNG.

## Run locally

From the repository root, run `python3 -m http.server 8000` and open `http://localhost:8000`. The site uses plain HTML, CSS, and JavaScript and needs no build step.

## Source

- `index.html` defines the canvas and controls. `style.css` styles the studio.
- `js/studio.js` handles drawing, history, audio, and export. `js/spatial.js`, `js/weld.js`, and `js/finishes.js` handle geometry and rendering.
- `js/monitor.js` draws the orientation indicator. `js/picker.js` handles the color picker.
- `assets/` contains the interface artwork, audio, and Iosevka Etoile font. The font license is in `assets/fonts/OFL.txt`.

## Publishing

Serve the repository root with GitHub Pages from the `main` branch. `CNAME` sets the custom domain to `umbo.ink`.
