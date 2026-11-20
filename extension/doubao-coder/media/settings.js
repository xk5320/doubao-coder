/* 豆包设置中心前端：原生 JS，无构建、无第三方依赖。 */
(function () {
  'use strict';

  const api = acquireVsCodeApi();
  const app = document.getElementById('app');
  const modeSub = document.getElementById('modeSub');
  const versionBadge = document.getElementById('versionBadge');
  const toastEl = document.getElementById('toast');

  const MODE_META = {
    cli: {
      title: '豆包 CLI',
      tag: '需订阅',
      desc: '文件读写、终端、技能、子 Agent 都由官方 CLI 执行；扩展只做界面。',
    },
    desktop: {
      title: '豆包桌面版',
      tag: '推荐 · 免 Key',
      desc: '复用桌面版登录态，通过调试端口驱动窗口；会抢占一次焦点。',
    },
    ark: {
      title: 'Ark API Key',
      tag: '按量',
      desc: '直连火山方舟 OpenAI 兼容接口；行内补全也走它。',
    },
  };

  const PERMISSIONS = [
    ['ask_risky', '按需确认（默认）'],
    ['ask_always', '始终询问'],
    ['always_allow', '全部允许（慎用）'],
  ];
  const EFFORTS = [
    ['', '不指定'],
    ['Low', '低'],
    ['Medium', '中'],
    ['High', '高'],
  ];
  const WORK_MODES = [
    ['auto', '跟随扩展模式'],
    ['local', '工作任务 · 本地电脑'],
    ['chat', '对话'],
  ];
  const REASONINGS = [
    ['', '不指定'],
    ['低', '低'],
    ['中', '中'],
    ['高', '高'],
    ['极高', '极高'],
  ];

  let state = null;
  let toastTimer = null;
  let inputTimer = null;

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      api.postMessage({ type: 'refresh' });
    });
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function toast(message, kind) {
    if (!toastEl) {
      return;
    }
    toastEl.textContent = message;
    toastEl.className = 'toast ' + (kind || 'ok');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      toastEl.className = 'toast hidden';
    }, 3200);
  }

  function section(title, subtitle) {
    const root = el('section', 'section');
    const head = el('div', 'section-head');
    head.appendChild(el('h2', 'section-title', title));
    if (subtitle) {
      head.appendChild(el('span', 'section-sub', subtitle));
    }
    root.appendChild(head);
    const body = el('div', 'section-body');
    root.appendChild(body);
    return { root: root, body: body };
  }

  function row(label, control, hint) {
    const wrap = el('div', 'row');
    const left = el('div', 'row-label');
    left.appendChild(el('span', 'row-name', label));
    if (hint) {
      left.appendChild(el('span', 'row-hint', hint));
    }
    wrap.appendChild(left);
    const right = el('div', 'row-control');
    right.appendChild(control);
    wrap.appendChild(right);
    return wrap;
  }

  function banner(ok, title, detail) {
    const node = el('div', 'banner ' + (ok ? 'ok' : 'bad'));
    node.appendChild(el('span', 'banner-dot', ok ? '●' : '●'));
    const text = el('div', 'banner-text');
    text.appendChild(el('div', 'banner-title', title));
    if (detail) {
      text.appendChild(el('div', 'banner-detail', detail));
    }
    node.appendChild(text);
    return node;
  }

  function selectFor(key, options, value) {
    const select = el('select', 'control');
    select.dataset.key = key;
    for (const pair of options) {
      const option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      if (String(pair[0]) === String(value)) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    return select;
  }

  function inputFor(key, value, type, placeholder, extra) {
    const input = el('input', 'control');
    input.type = type || 'text';
    input.dataset.key = key;
    input.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) {
      input.placeholder = placeholder;
    }
    if (extra && extra.min !== undefined) {
      input.min = String(extra.min);
    }
    if (extra && extra.max !== undefined) {
      input.max = String(extra.max);
    }
    if (extra && extra.step) {
      input.step = String(extra.step);
    }
    return input;
  }

  function checkFor(key, checked) {
    const label = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.key = key;
    input.checked = Boolean(checked);
    const track = el('span', 'switch-track');
    label.appendChild(input);
    label.appendChild(track);
    return label;
  }

  function button(label, action, kind) {
    const btn = el('button', kind || '', label);
    btn.dataset.action = action;
    return btn;
  }

  function actions(buttons) {
    const wrap = el('div', 'actions');
    for (const item of buttons) {
      wrap.appendChild(item);
    }
    return wrap;
  }

  function modeStatus(mode) {
    if (mode === 'cli') {
      const cli = state.cli || {};
      if (!cli.installed) {
        return { ok: false, text: '未安装' };
      }
      const version = cli.version ? 'v' + cli.version : '已安装';
      if (cli.loggedIn === true) {
        return { ok: true, text: version + ' · 登录有效' };
      }
      if (cli.loggedIn === false) {
        return { ok: false, text: version + ' · 未登录' };
      }
      return { ok: true, text: version + ' · 登录状态未验证' };
    }
    if (mode === 'desktop') {
      const desktop = state.desktop || {};
      if (desktop.connected) {
        return { ok: true, text: '调试端口已连接' };
      }
      return desktop.installed
        ? { ok: false, text: '已安装，但端口未连接' }
        : { ok: false, text: '未检测到桌面版' };
    }
    const ark = state.ark || {};
    return ark.hasKey
      ? { ok: true, text: 'API Key 已配置' }
      : { ok: false, text: '未配置 API Key' };
  }

  function renderModes() {
    const box = section('连接方式', '首次激活会弹一次选择，这里可以随时切换');
    const grid = el('div', 'modes');
    for (const mode of ['desktop', 'cli', 'ark']) {
      const status = modeStatus(mode);
      const card = el('label', 'mode' + (state.authMode === mode ? ' active' : ''));
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'authMode';
      radio.value = mode;
      radio.checked = state.authMode === mode;
      radio.addEventListener('change', function () {
        if (radio.checked) {
          api.postMessage({ type: 'setMode', mode: mode });
        }
      });
      card.appendChild(radio);
      const body = el('div', 'mode-body');
      const title = el('div', 'mode-title');
      title.appendChild(el('span', 'mode-name', MODE_META[mode].title));
      title.appendChild(el('span', 'tag', MODE_META[mode].tag));
      body.appendChild(title);
      body.appendChild(el('div', 'mode-status ' + (status.ok ? 'ok' : 'bad'), status.text));
      body.appendChild(el('div', 'mode-desc', MODE_META[mode].desc));
      card.appendChild(body);
      grid.appendChild(card);
    }
    box.body.appendChild(grid);
    return box.root;
  }

  function renderInstallCard(cli) {
    const card = el('div', 'install-card');
    const head = el('div', 'install-head');
    head.appendChild(el('span', 'install-dot', '!'));
    const text = el('div', 'install-text');
    text.appendChild(el('div', 'install-title', '还没安装豆包 CLI'));
    text.appendChild(
      el(
        'div',
        'install-desc',
        '一键安装会在本机执行 npm install -g @bytedance/doubao-cli；需要 Node.js 18+ 和豆包团队/企业订阅。安装输出会显示在下面。',
      ),
    );
    head.appendChild(text);
    card.appendChild(head);

    const runtime = cli.runtime;
    const status = el('div', 'install-runtime ' + (runtime && runtime.ok ? 'ok' : 'bad'));
    status.textContent =
      runtime && runtime.ok
        ? '环境就绪：Node ' + (runtime.nodeVersion || '?') + ' · npm ' + (runtime.npmVersion || '?')
        : '环境缺失：' + (runtime && runtime.error ? runtime.error : '未检测到 Node.js / npm');
    card.appendChild(status);

    const steps = el('ol', 'install-steps');
    for (const step of ['安装 CLI', '扫码登录', '回侧边栏发任务']) {
      steps.appendChild(el('li', '', step));
    }
    card.appendChild(steps);

    const rowActions = el('div', 'actions');
    rowActions.appendChild(button('一键自动安装', 'cliAutoInstall', 'primary'));
    rowActions.appendChild(button('在终端中安装', 'openTerminalInstall'));
    rowActions.appendChild(button('复制命令', 'copyInstall'));
    rowActions.appendChild(button('查看文档', 'openDocs', 'ghost'));
    if (!runtime || !runtime.ok) {
      rowActions.appendChild(button('下载 Node.js', 'openNodeDownload', 'link'));
    }
    card.appendChild(rowActions);

    const log = el('pre', 'install-log hidden');
    log.id = 'installLog';
    card.appendChild(log);
    return card;
  }

  function renderCli() {
    const cli = state.cli || {};
    const box = section('豆包 CLI 配置', '任务交给官方 CLI 执行；权限/工具/技能都在 CLI 侧');
    if (!cli.installed) {
      box.body.appendChild(renderInstallCard(cli));
      box.body.appendChild(
        row('可执行文件', inputFor('cli.path', cli.path, 'text', '留空自动探测'), 'CLI 装在非默认位置时在这里指定，然后点右上角「重新检测」'),
      );
      return box.root;
    }
    box.body.appendChild(
      banner(
        Boolean(cli.installed && cli.loggedIn !== false),
        cli.installed ? '已安装' + (cli.version ? ' v' + cli.version : '') : '未检测到豆包 CLI',
        cli.installed
          ? cli.loggedIn === true
            ? '登录有效'
            : cli.loggedIn === false
              ? '未登录：点「登录 CLI」扫码'
              : '登录状态未验证：点「检查登录」'
          : '安装命令：' + (state.installCommand || 'npm i -g @bytedance/doubao-cli'),
      ),
    );

    box.body.appendChild(row('权限策略', selectFor('cli.permissionMode', PERMISSIONS, cli.permissionMode), '传给 doubao --permission-mode'));
    box.body.appendChild(row('模型', inputFor('cli.model', cli.model, 'text', '留空 = Auto'), '传给 --model；可选值以 CLI 版本为准'));
    box.body.appendChild(row('推理强度', selectFor('cli.effort', EFFORTS, cli.effort), '传给 --effort'));
    box.body.appendChild(
      row('超时', inputFor('cli.timeoutMs', cli.timeoutMs, 'number', '600000', { min: 30000, max: 3600000, step: 1000 }), '毫秒；30 秒–60 分钟'),
    );
    box.body.appendChild(row('可执行文件', inputFor('cli.path', cli.path, 'text', '留空自动探测'), '一般不需要改；应用数据目录或 PATH 里的 doubao.exe'));

    box.body.appendChild(
      actions([
        button('登录 CLI', 'cliLogin', 'primary'),
        button('检查登录', 'cliCheck'),
        button('安装方式', 'cliInstall'),
        button('在终端打开', 'cliTerminal'),
        button('后台服务', 'cliService'),
        button('复制安装命令', 'copyInstall', 'ghost'),
      ]),
    );
    if (!cli.installed) {
      const hint = el('div', 'inline-hint');
      hint.appendChild(el('span', '', '第一次使用需要 Node.js 18+ 和团队/企业订阅。'));
      hint.appendChild(button('查看官方文档', 'openDocs', 'link'));
      box.body.appendChild(hint);
    }
    return box.root;
  }

  function renderDesktop() {
    const desktop = state.desktop || {};
    const box = section('豆包桌面版配置', '复用桌面端登录态，不需要 API Key');
    box.body.appendChild(
      banner(
        Boolean(desktop.connected),
        desktop.connected ? '调试端口已连接' : '尚未连接桌面版',
        desktop.connected
          ? '端口 ' + desktop.port
          : desktop.error || (desktop.installed ? '需要以调试端口启动豆包' : '未找到豆包桌面版，请先安装'),
      ),
    );
    box.body.appendChild(row('调试端口', inputFor('desktop.port', desktop.port, 'number', '9222', { min: 1, max: 65535 }), '默认 9222'));
    box.body.appendChild(row('桌面版路径', inputFor('desktop.exePath', desktop.exePath, 'text', '留空自动推导'), 'Doubao.exe 的完整路径'));
    box.body.appendChild(row('工作模式', selectFor('desktop.workMode', WORK_MODES, desktop.workMode), '发送前把桌面端切到哪个模式'));
    box.body.appendChild(row('模型', inputFor('desktop.model', desktop.model, 'text', '留空跟随桌面端'), '本地电脑模式下对齐的模型'));
    box.body.appendChild(row('推理强度', selectFor('desktop.reasoning', REASONINGS, desktop.reasoning), '本地电脑模式下对齐的推理强度'));
    box.body.appendChild(
      actions([
        button('连接检测', 'desktopConnect', 'primary'),
        button('以调试端口启动', 'desktopLaunch'),
        button('打开下载页', 'openDocs', 'ghost'),
      ]),
    );
    return box.root;
  }

  function renderArk() {
    const ark = state.ark || {};
    const box = section('Ark API Key 配置', '直连火山方舟；按 token 计费');
    box.body.appendChild(
      banner(Boolean(ark.hasKey), ark.hasKey ? 'API Key 已配置' : '未配置 API Key', ark.hasKey ? '来源：' + (ark.source || '未知') : '执行「设置 API Key」写入 SecretStorage'),
    );
    box.body.appendChild(row('模型', inputFor('model', ark.model, 'text', 'doubao-seed-code'), 'Ark 控制台里的模型名或推理接入点 ID'));
    box.body.appendChild(row('最大 token', inputFor('maxTokens', ark.maxTokens, 'number', '4096', { min: 1, max: 32768 }), '单次回复上限'));
    const base = el('div', 'readonly', ark.baseUrl || '');
    box.body.appendChild(row('基础地址', base, 'Coding Plan 用 .../api/coding/v3，可在 VS Code 设置里改'));
    box.body.appendChild(
      actions([
        button('设置 API Key', 'setApiKey', 'primary'),
        button('清除 API Key', 'clearApiKey'),
        button('打开 VS Code 设置', 'openVscodeSettings', 'ghost'),
      ]),
    );
    return box.root;
  }

  function renderGeneral() {
    const general = state.general || {};
    const box = section('通用', '对所有连接方式生效');
    box.body.appendChild(row('行内补全', checkFor('enableInlineCompletion', general.enableInlineCompletion), '需要 Ark API Key；CLI/桌面端本身不提供 FIM'));
    box.body.appendChild(row('终端自动执行', checkFor('terminal.autoRun', general.terminalAutoRun), '关闭后每条终端命令都要确认'));
    box.body.appendChild(row('写文件前审阅', checkFor('reviewEdits', general.reviewEdits), 'AI 改动先进入 Diff 审阅，接受后才落盘'));
    box.body.appendChild(row('接受后自动验证', checkFor('verify.afterAccept', general.autoVerifyAfterAccept), '接受改动后自动跑构建/测试，失败回灌给豆包'));
    box.body.appendChild(row('自动继续', checkFor('autoContinue', general.autoContinue), '桌面端回合结束后自动发「继续说」'));
    box.body.appendChild(
      row('自动继续倒计时', inputFor('autoContinueSeconds', general.autoContinueSeconds, 'number', '5', { min: 0, max: 120 }), '秒；0 表示关闭'),
    );
    return box.root;
  }

  function renderFooter() {
    const box = el('footer', 'foot');
    const left = el('div', 'foot-text');
    left.appendChild(el('div', '', '配置写入用户设置（全局）。'));
    left.appendChild(el('div', 'foot-sub', '连接方式切换后，侧边栏会立即使用新的通道。'));
    box.appendChild(left);
    const right = el('div', 'actions');
    right.appendChild(button('打开 VS Code 设置', 'openVscodeSettings', 'ghost'));
    right.appendChild(button('官方文档', 'openDocs', 'ghost'));
    box.appendChild(right);
    return box;
  }

  function render() {
    if (!state) {
      return;
    }
    const meta = MODE_META[state.authMode] || MODE_META.desktop;
    modeSub.textContent = '当前连接：' + meta.title;
    versionBadge.textContent = 'v' + (state.version || '?');
    const frag = document.createDocumentFragment();
    frag.appendChild(renderModes());
    frag.appendChild(state.authMode === 'cli' ? renderCli() : state.authMode === 'desktop' ? renderDesktop() : renderArk());
    frag.appendChild(renderGeneral());
    frag.appendChild(renderFooter());
    clear(app);
    app.appendChild(frag);
  }

  app.addEventListener('click', function (event) {
    const target = event.target.closest('[data-action]');
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    if (action === 'refresh') {
      api.postMessage({ type: 'refresh' });
      return;
    }
    api.postMessage({ type: 'action', value: action });
  });

  app.addEventListener('change', function (event) {
    const input = event.target.closest('[data-key]');
    if (!input) {
      return;
    }
    const key = input.dataset.key;
    if (input.type === 'checkbox') {
      api.postMessage({ type: 'update', key: key, value: input.checked });
      return;
    }
    if (input.tagName === 'SELECT') {
      api.postMessage({ type: 'update', key: key, value: input.value });
      return;
    }
    if (input.type === 'number') {
      if (String(input.value).trim() === '') {
        return;
      }
      api.postMessage({ type: 'update', key: key, value: Number(input.value) });
    }
  });

  app.addEventListener('input', function (event) {
    const input = event.target.closest('[data-key]');
    if (!input || input.tagName === 'SELECT' || input.type === 'checkbox') {
      return;
    }
    if (inputTimer) {
      clearTimeout(inputTimer);
    }
    inputTimer = setTimeout(function () {
      if (input.type === 'number' && String(input.value).trim() === '') {
        return;
      }
      const value = input.type === 'number' ? Number(input.value) : input.value;
      api.postMessage({ type: 'update', key: input.dataset.key, value: value });
    }, 450);
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'state') {
      state = message.state;
      render();
      return;
    }
    if (message.type === 'saved') {
      toast('已保存', 'ok');
      return;
    }
    if (message.type === 'notice') {
      toast(message.message || '完成', 'ok');
      return;
    }
    if (message.type === 'error') {
      toast(message.message || '操作失败', 'bad');
      return;
    }
    if (message.type === 'authResult') {
      toast(message.ok ? '登录有效' : '未登录：' + (message.detail || ''), message.ok ? 'ok' : 'bad');
      return;
    }
    if (message.type === 'installStart') {
      const log = app.querySelector('#installLog');
      if (log) {
        log.textContent = '';
        log.classList.remove('hidden');
      }
      const auto = app.querySelector('[data-action="cliAutoInstall"]');
      if (auto) {
        auto.disabled = true;
        auto.textContent = '正在安装…';
      }
      toast('开始安装豆包 CLI…', 'ok');
      return;
    }
    if (message.type === 'installProgress') {
      const log = app.querySelector('#installLog');
      if (log) {
        log.classList.remove('hidden');
        const line = el('div', 'install-log-line', message.line || '');
        log.appendChild(line);
        while (log.children.length > 200) {
          log.removeChild(log.firstChild);
        }
        log.scrollTop = log.scrollHeight;
      }
      return;
    }
    if (message.type === 'installDone') {
      const auto = app.querySelector('[data-action="cliAutoInstall"]');
      if (auto) {
        auto.disabled = false;
        auto.textContent = message.ok ? '安装完成' : '一键自动安装';
      }
      if (message.ok) {
        toast('安装完成' + (message.version ? ' v' + message.version : ''), 'ok');
      } else {
        toast('安装失败：' + (message.error || ''), 'bad');
        const log = app.querySelector('#installLog');
        if (log) {
          log.classList.remove('hidden');
          log.appendChild(el('div', 'install-log-line bad', message.error || '安装失败'));
        }
      }
    }
  });

  api.postMessage({ type: 'ready' });
})();
