"""Inline the live vault data and the shared kit into each mockup. Run: python3 src/build.py (from v2/)."""
import pathlib
here = pathlib.Path(__file__).parent
data = (here / 'data.json').read_text()
kit = (here / 'kit.js').read_text()
for name in 'abc':
    src = here / f'{name}.html'
    if not src.exists():
        continue
    html = src.read_text()
    html = html.replace('<!--@data-->', f'<script>window.HURDLE={data};</script>')
    html = html.replace('<!--@kit-->', f'<script>{kit}</script>')
    (here.parent / f'{name}.html').write_text(html)
    print('built', name)
