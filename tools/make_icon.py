"""生成扩展图标：圆圈 + 「豆」+ 小字 "coder"，全部转成矢量路径（不依赖运行环境字体）。

用法：python tools/make_icon.py
输出： dist/icon-128.svg、dist/mono-24.svg、dist/mono-24-dou.svg（备选）
"""
import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

OUT = sys.argv[1] if len(sys.argv) > 1 else r"D:\rex86\doubao-re\dist"
CJK_FONT = r"C:\Windows\Fonts\msyhbd.ttc"   # 微软雅黑 Bold
LATIN_FONT = r"C:\Windows\Fonts\seguisb.ttf"  # Segoe UI Semibold


def load_glyph(font, ch):
    cmap = font.getBestCmap()
    name = cmap.get(ord(ch))
    if name is None:
        raise SystemExit(f"字体里没有字形: {ch!r}")
    glyph = font["glyf"][name] if "glyf" in font else font["CFF "].cff.topDictIndex[0].CharStrings[name]
    return font.getGlyphSet(), name


def glyph_path(font, ch):
    gs, name = load_glyph(font, ch)
    pen = SVGPathPen(gs)
    gs[name].draw(pen)
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    adv = font["hmtx"][name][0]
    return pen.getCommands(), (bp.bounds or (0, 0, adv, 0)), adv


def run_path(font, text, tracking=0.0):
    """把一串字符拼成一条路径，返回 (path, bounds, advance)。"""
    parts = []
    x = 0.0
    xmin = ymin = 1e9
    xmax = ymax = -1e9
    for ch in text:
        d, (gx0, gy0, gx1, gy1), adv = glyph_path(font, ch)
        if d:
            parts.append(f'<path d="{d}" transform="translate({x:.1f},0)"/>')
        xmin = min(xmin, x + gx0)
        xmax = max(xmax, x + gx1)
        ymin = min(ymin, gy0)
        ymax = max(ymax, gy1)
        x += adv + tracking
    return "".join(parts), (xmin, ymin, xmax, ymax), x - tracking


def place(font, text, target_cx, target_top, target_h, tracking=0.0):
    inner, (x0, y0, x1, y1), _ = run_path(font, text, tracking)
    if y1 <= y0:
        raise SystemExit("空字形")
    s = target_h / (y1 - y0)
    tx = target_cx - (x0 + (x1 - x0) / 2) * s
    ty = target_top + y1 * s
    return f'<g transform="translate({tx:.2f},{ty:.2f}) scale({s:.5f},{-s:.5f})">{inner}</g>'


cjk = TTFont(CJK_FONT, fontNumber=0)
latin = TTFont(LATIN_FONT)

# ---------- 128×128：列表图标（圆圈 + 豆 + coder） ----------
dou_128 = place(cjk, "豆", 64, 29, 38)
coder_128 = place(latin, "coder", 64, 92, 12, tracking=30)
icon_svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="48" r="38" fill="none" stroke="#1E3A8A" stroke-width="5.5"/>
  {dou_128.replace('<g ', '<g fill="#1E3A8A" ')}
  {coder_128.replace('<g ', '<g fill="#1E3A8A" ')}
</svg>"""

# ---------- 24×24：活动栏单色（圆圈 + 豆 + coder） ----------
dou_24 = place(cjk, "豆", 12, 4.3, 8.6)
coder_24 = place(latin, "coder", 12, 17.4, 3.0, tracking=70)
mono_svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#C9C9C9">
  <circle cx="12" cy="8.6" r="7.6" fill="none" stroke="#C9C9C9" stroke-width="1.7"/>
  {dou_24.replace('<g ', '<g fill="#C9C9C9" ')}
  {coder_24.replace('<g ', '<g fill="#C9C9C9" ')}
</svg>"""

# 备选：24px 只放「豆」（3px 的小字在活动栏里必然糊成一个点）
mono_dou_svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#C9C9C9">
  <circle cx="12" cy="12" r="9.2" fill="none" stroke="#C9C9C9" stroke-width="1.8"/>
  {place(cjk, "豆", 12, 6.6, 10.6).replace('<g ', '<g fill="#C9C9C9" ')}
</svg>"""

for name, content in (
    ("icon-128.svg", icon_svg),
    ("mono-24.svg", mono_svg),
    ("mono-24-dou.svg", mono_dou_svg),
):
    p = os.path.join(OUT, name)
    open(p, "w", encoding="utf-8").write(content)
    print("wrote", name, len(content), "bytes")
