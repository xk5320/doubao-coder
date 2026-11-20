#!/usr/bin/env python
"""生成一个「本地学习沙盒」：把导出的前端资源拼成一个静态页面。

仅本机研究用：
  - 不连接豆包服务端，不携带任何账号凭据
  - 不进 vsix、不参与分发
  - 只为观察表现层骨架（组件结构 / 样式组织 / 报错点）

用法：
  python tools/make_lab.py            # 生成 artifacts/lab/index.html
  python tools/lab_server.py          # 起本地静态服务器
"""
import json
import os

ROOT = r"D:\rex86\doubao-re\artifacts\frontend"
LAB = r"D:\rex86\doubao-re\artifacts\lab"

STUB = r"""
// ---- 本地沙盒桩：把原生桥替换成记录器，只打印调用，不做任何网络请求 ----
(function () {
  const calls = [];
  window.__LAB_CALLS = calls;
  function makeBridge(name) {
    return {
      call(method, params) {
        calls.push({ bridge: name, method, params });
        console.log('[bridge]', name, method, params);
        return Promise.resolve({});
      },
      on() { return this; },
      once() { return this; },
      off() { return this; },
      trigger() { return this; },
      setAppID() {},
      _fetchQueue: [],
      _handleMessageFromApp() {},
      _handleMessageFromToutiao() {},
    };
  }
  window.JSBridge = makeBridge('JSBridge');
  window.Native2JSBridge = makeBridge('Native2JSBridge');
  window.ToutiaoJSBridge = makeBridge('ToutiaoJSBridge');
  window.__DOUBAO_LAB__ = true;

  // 断掉一切网络：沙盒里不允许连服务端
  const block = function (url) {
    console.warn('[lab] 已阻断网络请求:', url);
    return Promise.reject(new Error('lab: network blocked'));
  };
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return block(url);
  };
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url) {
    console.warn('[lab] 已阻断 WebSocket:', url);
    throw new Error('lab: websocket blocked');
  };
  // 记录脚本错误，方便观察初始化到哪一步
  window.addEventListener('error', function (e) {
    (window.__LAB_ERRORS = window.__LAB_ERRORS || []).push(String(e.message));
    console.error('[lab] error:', e.message);
  });
})();
"""


def main() -> None:
    os.makedirs(LAB, exist_ok=True)
    manifest_path = os.path.join(ROOT, "_manifest.json")
    if not os.path.exists(manifest_path):
        print("缺少 _manifest.json，请先运行 tools/extract_frontend.py")
        return
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)

    css = [m for m in manifest if (m.get("file") or "").endswith(".css")]
    js = [m for m in manifest if (m.get("file") or "").endswith(".js")]

    css_links = "\n".join(
        '  <link rel="stylesheet" href="../frontend/%s" />' % m["file"] for m in css
    )
    js_tags = "\n".join('  <script src="../frontend/%s"></script>' % m["file"] for m in js)

    html = ("""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>豆包前端 · 本地学习沙盒</title>
<style>
  html, body { height: 100%; margin: 0; background: #1e1e1e; color: #ddd;
    font-family: system-ui, "Microsoft YaHei", sans-serif; }
  #banner { padding: 8px 12px; background: #2d2d2d; border-bottom: 1px solid #3c3c3c;
    font-size: 12px; color: #aaa; }
  #banner b { color: #e6b450; }
  #root { min-height: calc(100% - 34px); }
  #log { position: fixed; right: 8px; bottom: 8px; width: 380px; max-height: 40vh;
    overflow: auto; background: rgba(0,0,0,.75); border: 1px solid #444; border-radius: 6px;
    padding: 8px; font: 11px/1.5 Consolas, monospace; white-space: pre-wrap; display: none; }
</style>
__CSS__
</head>
<body>
<div id="banner">
  本地学习沙盒 · <b>不连接服务端</b> · 只用于观察表现层骨架
  <button onclick="document.getElementById('log').style.display='block'">显示桥调用</button>
</div>
<div id="root"></div>
<pre id="log"></pre>
<script>
__STUB__
</script>
<script>
  // 把桥调用与错误实时打到右下角面板
  setInterval(function () {
    var log = document.getElementById('log');
    var calls = window.__LAB_CALLS || [];
    var errs = window.__LAB_ERRORS || [];
    log.textContent = '桥调用 ' + calls.length + ' 次\\n' + JSON.stringify(calls.slice(-8), null, 1)
      + '\\n\\n错误 ' + errs.length + ' 个\\n' + errs.slice(-6).join('\\n');
  }, 800);
</script>
__JS__
</body>
</html>
""")

    html = html.replace("__CSS__", css_links).replace("__STUB__", STUB).replace("__JS__", js_tags)

    out = os.path.join(LAB, "index.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("已生成:", out)
    print("CSS: %d 个  JS: %d 个" % (len(css), len(js)))
    print("启动服务器: python tools/lab_server.py")


if __name__ == "__main__":
    main()
