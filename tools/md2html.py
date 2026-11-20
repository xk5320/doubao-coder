"""极简 Markdown → 独立 HTML（够用于安装指南：标题/表格/代码块/列表/引用/行内样式）。"""
import base64
import html
import os
import re
import sys

SRC = sys.argv[1]
DST = sys.argv[2]
ICON = sys.argv[3] if len(sys.argv) > 3 else ""

lines = open(SRC, encoding="utf-8").read().split("\n")

def inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', out)
    return out

blocks = []
i = 0
n = len(lines)
while i < n:
    line = lines[i]
    stripped = line.strip()

    if not stripped:
        i += 1
        continue

    # 代码块
    if stripped.startswith("```"):
        lang = stripped[3:].strip()
        i += 1
        buf = []
        while i < n and not lines[i].strip().startswith("```"):
            buf.append(lines[i])
            i += 1
        i += 1
        blocks.append(
            '<pre class="code"%s><code>%s</code></pre>'
            % (' data-lang="%s"' % html.escape(lang) if lang else "", html.escape("\n".join(buf)))
        )
        continue

    # 表格
    if stripped.startswith("|") and i + 1 < n and re.match(r"^\|[\s:\-|]+\|$", lines[i + 1].strip()):
        header = [c.strip() for c in stripped.strip("|").split("|")]
        i += 2
        rows = []
        while i < n and lines[i].strip().startswith("|"):
            rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
            i += 1
        thead = "".join("<th>%s</th>" % inline(c) for c in header)
        tbody = "".join(
            "<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in row) for row in rows
        )
        blocks.append('<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>' % (thead, tbody))
        continue

    # 标题
    m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
    if m:
        level = len(m.group(1))
        blocks.append("<h%d>%s</h%d>" % (level, inline(m.group(2)), level))
        i += 1
        continue

    # 分割线
    if re.match(r"^-{3,}$", stripped):
        blocks.append("<hr/>")
        i += 1
        continue

    # 引用
    if stripped.startswith(">"):
        buf = []
        while i < n and lines[i].strip().startswith(">"):
            buf.append(lines[i].strip().lstrip(">").strip())
            i += 1
        blocks.append('<blockquote>%s</blockquote>' % "<br/>".join(inline(b) for b in buf))
        continue

    # 列表
    if re.match(r"^([-*]|\d+\.)\s+", stripped):
        ordered = bool(re.match(r"^\d+\.", stripped))
        items = []
        while i < n and re.match(r"^([-*]|\d+\.)\s+", lines[i].strip()):
            item = re.sub(r"^([-*]|\d+\.)\s+", "", lines[i].strip())
            i += 1
            # 续行（缩进 2+ 空格）
            while i < n and lines[i].startswith("  ") and lines[i].strip():
                item += " " + lines[i].strip()
                i += 1
            items.append("<li>%s</li>" % inline(item))
        tag = "ol" if ordered else "ul"
        blocks.append("<%s>%s</%s>" % (tag, "".join(items), tag))
        continue

    # 段落
    buf = [stripped]
    i += 1
    while i < n and lines[i].strip() and not re.match(r"^(#{1,6}\s|```|\||>|([-*]|\d+\.)\s|^-{3,}$)", lines[i].strip()):
        buf.append(lines[i].strip())
        i += 1
    blocks.append("<p>%s</p>" % "<br/>".join(inline(b) for b in buf))

icon_html = ""
if ICON and os.path.exists(ICON):
    b64 = base64.b64encode(open(ICON, "rb").read()).decode()
    icon_html = '<img class="logo" src="data:image/png;base64,%s" alt="icon"/>' % b64

HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>豆包编程助手 · 安装指南</title>
<style>
:root{--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--bg:#fff;--code:#f6f8fa;--accent:#1e3a8a;}
*{box-sizing:border-box}
body{margin:0;background:#f2f4f7;color:var(--fg);
 font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;}
.page{max-width:920px;margin:32px auto;background:var(--bg);border:1px solid var(--line);
 border-radius:14px;padding:40px 44px;box-shadow:0 6px 28px rgba(16,24,40,.06);}
.logo{width:64px;height:64px;border-radius:14px;display:block;margin-bottom:8px}
h1{font-size:30px;margin:6px 0 10px;letter-spacing:-.3px}
h2{font-size:21px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:17px;margin:22px 0 8px}
p{margin:10px 0}
ul,ol{margin:10px 0 10px 22px;padding:0}
li{margin:4px 0}
a{color:#0b62d6;text-decoration:none}
a:hover{text-decoration:underline}
code{background:var(--code);border:1px solid var(--line);border-radius:5px;
 padding:1px 5px;font:14px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace}
pre.code{background:var(--code);border:1px solid var(--line);border-radius:10px;
 padding:14px 16px;overflow:auto;margin:12px 0}
pre.code code{background:none;border:none;padding:0;font-size:13.5px;line-height:1.65}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14.5px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f7f9fb;font-weight:600;white-space:nowrap}
tbody tr:nth-child(even){background:#fcfdfe}
blockquote{margin:14px 0;padding:10px 16px;background:#f7f9fb;border-left:4px solid var(--accent);
 border-radius:0 8px 8px 0;color:var(--muted)}
blockquote p{margin:0}
hr{border:none;border-top:1px solid var(--line);margin:28px 0}
.foot{margin-top:36px;color:var(--muted);font-size:13px}
@media print{body{background:#fff}.page{box-shadow:none;border:none;margin:0;padding:0;max-width:none}}
</style></head><body><div class="page">
__ICON__
__BODY__
<div class="foot">本文件由 <code>安装指南.md</code> 生成，随 vsix 一起分发；所有路径与命令均为 Windows 版。</div>
</div></body></html>
"""

HTML = HTML_TEMPLATE.replace("__ICON__", icon_html).replace("__BODY__", "\n".join(blocks))
open(DST, "w", encoding="utf-8").write(HTML)
print("wrote", DST, os.path.getsize(DST), "bytes,", len(blocks), "blocks")

