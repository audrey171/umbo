"""Pack the editable studio into the static entry point used by GitHub Pages."""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ESBUILD = [os.environ["ESBUILD"]] if "ESBUILD" in os.environ else ["npx", "--yes", "esbuild@0.27.0"]


def minify(source, language):
    return subprocess.run(
        [*ESBUILD, "--minify", "--target=es2020", f"--loader={language}"],
        input=source, text=True, capture_output=True, check=True,
    ).stdout


def embed_icon(match):
    data = (ROOT / match.group()).read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(data).decode("ascii")


page = (ROOT / "studio.html").read_text()
script_tag = r'<script src="(js/[^"]+)"></script>'
sources = re.findall(script_tag, page)
if not sources:
    raise ValueError("The studio template has no scripts")
# Preserve classic-script globals, including the functions serialized for the weld worker.
script = minify("\n;\n".join((ROOT / path).read_text() for path in sources), "js")
revision = hashlib.sha256(script.encode()).hexdigest()[:12]
css = minify((ROOT / "style.css").read_text(), "css").rstrip()
page = re.sub(script_tag + r'\s*', '', page)
page = page.replace('<link rel="stylesheet" href="style.css">', f'<style>{css}</style>')
page = re.sub(r'assets/ui/[\w-]+\.svg', embed_icon, page)
page = page.replace('</head>', f'<script defer src="js/studio.min.js?v={revision}"></script>\n</head>')
(ROOT / "js/studio.min.js").write_text(script)
(ROOT / "index.html").write_text("<!-- Generated from studio.html by tools/build.py -->\n" + page)
