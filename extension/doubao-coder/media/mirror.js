/* 豆包镜像面板（M1）：接收画面帧并贴到 <img>。 */
(function () {
  const vscode = acquireVsCodeApi();
  const img = document.getElementById('cast');
  const statusEl = document.getElementById('status');
  const placeholder = document.getElementById('placeholder');
  const fpsEl = document.getElementById('fps');
  const sizeEl = document.getElementById('size');
  const startBtn = document.getElementById('btn-start');
  const stopBtn = document.getElementById('btn-stop');

  let frames = 0;
  let windowStart = Date.now();

  function tickFps() {
    const now = Date.now();
    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      fpsEl.textContent = '帧率 ' + Math.round((frames * 1000) / elapsed) + ' fps';
      frames = 0;
      windowStart = now;
    }
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'frame': {
        if (img) {
          img.src = 'data:image/jpeg;base64,' + message.data;
          img.classList.add('on');
          img.style.width = '100%';
          img.style.height = '100%';
        }
        if (placeholder) {
          placeholder.style.display = 'none';
        }
        frames += 1;
        tickFps();
        if (sizeEl && message.width && message.height) {
          sizeEl.textContent = '源画面 ' + message.width + '×' + message.height;
        }
        break;
      }
      case 'status':
        if (statusEl) {
          statusEl.textContent = message.text || '';
        }
        break;
      case 'error':
        if (statusEl) {
          statusEl.textContent = '错误：' + (message.message || '');
        }
        break;
      default:
        break;
    }
  });

  if (startBtn) {
    startBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'start' });
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'stop' });
      if (statusEl) {
        statusEl.textContent = '已停止';
      }
    });
  }


  /* ================= M2：把输入转发回豆包 ================= */

  const stage = document.getElementById('stage');

  /** 把鼠标坐标换算成画面内的归一化坐标（0..1）。 */
  function normalized(event) {
    if (!img || !img.getBoundingClientRect) {
      return { x: 0, y: 0 };
    }
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return { x: 0, y: 0 };
    }
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function sendInput(payload) {
    if (!img || !img.classList.contains('on')) {
      return;
    }
    const point = payload.point || {};
    vscode.postMessage(Object.assign({ type: 'mirrorInput' }, payload, point));
  }

  if (stage) {
    stage.addEventListener('mousedown', function (event) {
      event.preventDefault();
      stage.focus();
      sendInput({ kind: 'click', button: event.button === 2 ? 'right' : 'left', point: normalized(event) });
    });

    let moveTimer = 0;
    stage.addEventListener('mousemove', function (event) {
      if (moveTimer) {
        return;
      }
      moveTimer = window.setTimeout(function () {
        moveTimer = 0;
      }, 60);
      sendInput({ kind: 'move', point: normalized(event) });
    });

    stage.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });

    stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      sendInput({
        kind: 'wheel',
        deltaY: Math.round(event.deltaY),
        deltaX: Math.round(event.deltaX),
        point: normalized(event),
      });
    }, { passive: false });

    stage.setAttribute('tabindex', '0');
    stage.addEventListener('keydown', function (event) {
      // 可打印字符走 insertText（中文/粘贴更稳），其余转发按键
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        vscode.postMessage({ type: 'mirrorInput', kind: 'text', text: event.key });
        return;
      }
      if (event.ctrlKey && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (text) {
            if (text) {
              vscode.postMessage({ type: 'mirrorInput', kind: 'text', text: text });
            }
          }).catch(function () {});
        }
        return;
      }
      event.preventDefault();
      vscode.postMessage({
        type: 'mirrorInput',
        kind: 'key',
        eventType: 'keyDown',
        key: event.key,
        code: event.code,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
      });
    });
  }

  window.addEventListener('resize', function () {
    vscode.postMessage({ type: 'mirrorResize' });
  });

  /* ================= 视图：适配 / 原始 / 沉浸 ================= */

  let fitMode = true;
  const fitBtn = document.getElementById('btn-fit');
  const immersiveBtn = document.getElementById('btn-immersive');

  function applyFit() {
    if (!img) {
      return;
    }
    if (fitMode) {
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
    } else {
      img.style.width = 'auto';
      img.style.height = 'auto';
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
    }
    if (fitBtn) {
      fitBtn.textContent = fitMode ? '原始大小' : '适配窗口';
    }
  }

  if (fitBtn) {
    fitBtn.addEventListener('click', function () {
      fitMode = !fitMode;
      applyFit();
    });
  }

  if (immersiveBtn) {
    immersiveBtn.addEventListener('click', function () {
      const on = document.body.classList.toggle('immersive');
      immersiveBtn.textContent = on ? '退出沉浸' : '沉浸';
      vscode.postMessage({ type: 'mirrorResize' });
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
