"""把扩展 webview 的工具卡片改成「豆包同款」样式，并加建议追问 chip。

只做三件事：
1) 重写 toolStart / toolEnd 的 DOM 结构（tool 胶囊 + 一行 JSON + 复制 + 折叠详情/结果）
2) 记录每轮工具数与助手文本，结束后渲染建议 chip
3) 在 chat.css 末尾追加样式（覆盖旧样式）
"""
import io
import re
import sys

JS = r"D:\rex86\doubao-re\extension\doubao-coder\media\chat.js"
CSS = r"D:\rex86\doubao-re\extension\doubao-coder\media\chat.css"

src = io.open(JS, encoding="utf-8").read()

# ---------- 1) 新增状态 ----------
if "let turnTools = 0;" not in src:
    src = src.replace(
        "const toolCards = new Map();",
        "const toolCards = new Map();\n  /** 当前这一轮的工具调用次数与助手文本，用来生成建议。 */\n  let turnTools = 0;\n  let turnText = '';",
        1,
    )

# ---------- 2) toolStart / toolEnd 重写 ----------
new_tools = r"""  function toolStart(id, name, args) {
    // 先把当前正在流式输出的气泡收尾，保证卡片按时间顺序出现。
    finishAssistant();
    showEmpty(false);
    turnTools += 1;

    const card = el('div', 'tool-card running');
    const head = el('div', 'tool-head');

    head.appendChild(el('span', 'tool-chip', 'tool'));
    head.appendChild(el('span', 'tool-caret', '\u2304'));

    const json = el('span', 'tool-json');
    json.textContent = '{"name":"' + name + '","arguments":' + JSON.stringify(args || {}) + '}';
    head.appendChild(json);

    const copy = el('button', 'tool-copy', '\u29c9');
    copy.title = '复制这次调用';
    copy.addEventListener('click', function (ev) {
      ev.stopPropagation();
      copyText(json.textContent);
      copy.textContent = '\u2713';
      setTimeout(function () { copy.textContent = '\u29c9'; }, 1200);
    });
    head.appendChild(copy);

    card.appendChild(head);

    const detail = el('pre', 'tool-detail hidden');
    detail.textContent = JSON.stringify({ name: name, arguments: args || {} }, null, 2);
    card.appendChild(detail);

    head.addEventListener('click', function () {
      detail.classList.toggle('hidden');
      card.classList.toggle('expanded');
    });

    messagesEl.appendChild(card);
    toolCards.set(id, { card: card, detail: detail });
    scrollToBottom();
  }

  function toolEnd(id, name, ok, content) {
    const entry = toolCards.get(id);
    if (!entry) {
      return;
    }
    entry.card.classList.remove('running');
    entry.card.classList.add(ok ? 'ok' : 'failed');
    const body = el('pre', 'tool-result');
    const text = String(content || '');
    body.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断显示）' : text;
    entry.card.appendChild(body);
    scrollToBottom();
  }
"""

start = src.index("  function toolStart(id, name, args) {")
end = src.index("  function addImage(url, full, alt) {")
src = src[:start] + new_tools + "\n" + src[end:]

# ---------- 3) 建议 chip ----------
suggest = r"""  /** 从助手回复里抽 2~3 条建议，抽不到就用兜底建议。 */
  function suggestFor(text, tools) {
    const out = [];
    const lines = String(text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < 3; i -= 1) {
      const m = /^(?:\d+[.、)]|[-*•])\s*(.{2,40})$/.exec(lines[i]);
      if (m) {
        out.unshift(m[1].replace(/[。；;：:]+$/, ''));
      }
    }
    if (out.length >= 2) {
      return out.slice(-3);
    }
    if (tools > 0) {
      return ['继续', '看看改了什么', '跑一次自检'];
    }
    return ['继续说', '给个代码例子', '解释得更简单些'];
  }

  /** 追加一行建议 chip（点一下即发送）。 */
  function addSuggestions(items) {
    if (!items || !items.length) {
      return;
    }
    const row = el('div', 'suggest-row');
    items.forEach(function (text) {
      const chip = el('button', 'suggest-chip', text + ' \u2192');
      chip.addEventListener('click', function () {
        if (busy) {
          return;
        }
        inputEl.value = text;
        send();
      });
      row.appendChild(chip);
    });
    messagesEl.appendChild(row);
    scrollToBottom();
  }

"""
marker = "  function addImage(url, full, alt) {"
src = src.replace(marker, suggest + marker, 1)

# ---------- 4) 事件接线 ----------
src = src.replace(
    """      case 'user':
        addMessage('user', message.text);
        startAssistant();
        break;""",
    """      case 'user':
        turnTools = 0;
        turnText = '';
        addMessage('user', message.text);
        startAssistant();
        break;""",
    1,
)
src = src.replace(
    """        streamingBuffer += message.text;
        scheduleStreamingRender();""",
    """        streamingBuffer += message.text;
        turnText += message.text;
        scheduleStreamingRender();""",
    1,
)
src = src.replace(
    """      case 'assistant_done':
        finishAssistant();
        break;""",
    """      case 'assistant_done':
        finishAssistant();
        addSuggestions(suggestFor(turnText, turnTools));
        break;""",
    1,
)

io.open(JS, "w", encoding="utf-8", newline="\n").write(src)
print("chat.js updated:", len(src), "bytes")

# ---------- 5) CSS 追加 ----------
css_add = r"""
/* ===== 工具卡片：对齐豆包桌面端的 tool 胶囊样式 ===== */
.tool-card {
  margin: 6px 0 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: 10px;
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.06));
  overflow: hidden;
  border-left: 3px solid rgba(128, 128, 128, 0.45);
}
.tool-card.running { border-left-color: #d9a441; }
.tool-card.ok { border-left-color: #3fa45b; }
.tool-card.failed { border-left-color: #d9534f; }

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}
.tool-chip {
  flex: none;
  font: 11px/1.6 ui-monospace, Consolas, monospace;
  color: var(--vscode-descriptionForeground, #999);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: 5px;
  padding: 0 6px;
}
.tool-caret {
  flex: none;
  color: var(--vscode-descriptionForeground, #999);
  font-size: 11px;
  transition: transform 0.15s ease;
}
.tool-card.expanded .tool-caret { transform: rotate(180deg); }

.tool-json {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 12px/1.7 ui-monospace, Consolas, monospace;
  color: var(--vscode-foreground);
  opacity: 0.9;
}
.tool-copy {
  flex: none;
  border: none;
  background: none;
  color: var(--vscode-descriptionForeground, #999);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.tool-copy:hover { color: var(--vscode-foreground); }

.tool-detail,
.tool-result {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  font: 12px/1.6 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow: auto;
  background: var(--vscode-editor-background, transparent);
}
.tool-result { opacity: 0.85; }
.tool-detail.hidden { display: none; }

/* ===== 建议追问 chip（豆包底部的「xxx →」） ===== */
.suggest-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 14px;
  padding: 0 2px;
}
.suggest-chip {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  background: transparent;
  color: var(--vscode-foreground);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.88;
}
.suggest-chip:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
  opacity: 1;
}
"""
css = io.open(CSS, encoding="utf-8").read()
if "/* ===== 工具卡片：对齐豆包桌面端" not in css:
    css = css.rstrip() + "\n" + css_add
io.open(CSS, "w", encoding="utf-8", newline="\n").write(css)
print("chat.css updated:", len(css), "bytes")
