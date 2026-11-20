/**
 * 极简 DOM 宿主：让 media/chat.js（IIFE + 原生 DOM）能在 node:vm 里真实跑起来。
 *
 * 目的不是实现浏览器，而是支撑「对话区状态渲染」的回归测试：
 * - 元素树 / 文本节点 / DocumentFragment（appendChild 时摊平）
 * - querySelector(All)：只实现 chat.js 用到的选择器 —— tag、.class、#id、
 *   [attr]、[attr="v"]、:last-child、:first-child、:not(...)、逗号分组、后代选择器
 * - innerHTML setter 的语义是「清空子节点」（测试只依赖这个语义），同时把纯文本
 *   变成文本节点，让 textContent 断言可用
 * - getElementById、body、documentElement、createElement、createDocumentFragment
 * - 可控的 setTimeout / setInterval / requestAnimationFrame：flush() 只推进
 *   <= 40ms 的一次性任务（rAF 16ms、setTimeout 0），500ms 的轮询不会被推进，
 *   也不会把 Node 进程挂住
 *
 * 不实现：完整 CSS 解析、布局、事件冒泡、HTML 解析、真实动画帧。
 */

'use strict';

const vm = require('node:vm');

const FLUSH_MAX_DELAY = 40;
const FLUSH_MAX_STEPS = 5000;

/* ------------------------------ 选择器引擎 ------------------------------ */

/** 按逗号拆选择器分组（不处理引号里的逗号，chat.js 用不到）。 */
function splitGroups(selector) {
  return String(selector || '')
    .split(',')
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
}

/** 按空白拆后代组合（[] 和 () 内部的空白不拆）。 */
function splitDescendant(group) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const ch of String(group)) {
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === ']' || ch === ')') {
      depth -= 1;
    }
    if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function lastElementChild(node) {
  if (!node || !node._children) {
    return null;
  }
  for (let i = node._children.length - 1; i >= 0; i -= 1) {
    if (node._children[i].nodeType === 1) {
      return node._children[i];
    }
  }
  return null;
}

function firstElementChildOf(node) {
  if (!node || !node._children) {
    return null;
  }
  for (const child of node._children) {
    if (child.nodeType === 1) {
      return child;
    }
  }
  return null;
}

/** 匹配单个复合选择器（tag.class#id[attr]:pseudo）。 */
function compoundMatches(el, compound) {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  let rest = String(compound);
  if (!rest) {
    return false;
  }

  if (rest[0] === '*') {
    rest = rest.slice(1);
  } else {
    const tag = /^[A-Za-z][\w-]*/.exec(rest);
    if (tag) {
      if (el.tagName !== tag[0].toUpperCase()) {
        return false;
      }
      rest = rest.slice(tag[0].length);
    }
  }

  while (rest.length > 0) {
    if (rest[0] === '#') {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) {
        return false;
      }
      if (el.getAttribute('id') !== m[1]) {
        return false;
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    if (rest[0] === '.') {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) {
        return false;
      }
      if (!el.classList.contains(m[1])) {
        return false;
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    if (rest[0] === '[') {
      const end = rest.indexOf(']');
      if (end < 0) {
        return false;
      }
      const body = rest.slice(1, end);
      rest = rest.slice(end + 1);
      const eq = body.indexOf('=');
      if (eq < 0) {
        if (!el.hasAttribute(body.trim())) {
          return false;
        }
      } else {
        const name = body.slice(0, eq).trim();
        let value = body.slice(eq + 1).trim();
        if ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'")) {
          value = value.slice(1, -1);
        }
        if (el.getAttribute(name) !== value) {
          return false;
        }
      }
      continue;
    }
    if (rest[0] === ':') {
      const m = /^:([\w-]+)(?:\(([^)]*)\))?/.exec(rest);
      if (!m) {
        return false;
      }
      const name = m[1];
      const arg = m[2];
      rest = rest.slice(m[0].length);
      if (name === 'last-child') {
        if (!el.parentNode || lastElementChild(el.parentNode) !== el) {
          return false;
        }
      } else if (name === 'first-child') {
        if (!el.parentNode || firstElementChildOf(el.parentNode) !== el) {
          return false;
        }
      } else if (name === 'not') {
        if (matchesSelector(el, arg || '')) {
          return false;
        }
      } else {
        // 未实现的选择器一律不匹配，避免静默给出错误结果。
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function matchesGroup(el, group) {
  const parts = splitDescendant(group);
  if (parts.length === 0) {
    return false;
  }
  if (!compoundMatches(el, parts[parts.length - 1])) {
    return false;
  }
  let ancestor = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (ancestor) {
      if (ancestor.nodeType === 1 && compoundMatches(ancestor, parts[i])) {
        found = true;
        ancestor = ancestor.parentNode;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  return splitGroups(selector).some(function (group) {
    return matchesGroup(el, group);
  });
}

function collectDescendants(root, out) {
  const acc = out || [];
  if (!root || !root._children) {
    return acc;
  }
  for (const child of root._children) {
    if (child.nodeType === 1) {
      acc.push(child);
      collectDescendants(child, acc);
    }
  }
  return acc;
}

/* ------------------------------ 文本 / HTML ------------------------------ */

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeNode(node) {
  if (node.nodeType === 3) {
    return escapeText(node._data);
  }
  if (node.nodeType !== 1) {
    return '';
  }
  const attrs = [];
  for (const [name, value] of node._attrs) {
    attrs.push(' ' + name + '="' + escapeText(value) + '"');
  }
  const cls = node._classes.size > 0 ? ' class="' + escapeText(Array.from(node._classes).join(' ')) + '"' : '';
  const tag = node.tagName.toLowerCase();
  return '<' + tag + cls + attrs.join('') + '>' + node._children.map(serializeNode).join('') + '</' + tag + '>';
}

/* ------------------------------ 事件 ------------------------------ */

function makeEvent(type, init) {
  const event = Object.assign(
    {
      type: type,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target: null,
      currentTarget: null,
      _stopped: false,
      _immediateStopped: false,
    },
    init || {},
  );
  event.preventDefault = function () {
    event.defaultPrevented = true;
  };
  event.stopPropagation = function () {
    event._stopped = true;
  };
  event.stopImmediatePropagation = function () {
    event._stopped = true;
    event._immediateStopped = true;
  };
  return event;
}

function addListener(store, type, fn) {
  if (typeof fn !== 'function') {
    return;
  }
  const key = String(type);
  if (!store.has(key)) {
    store.set(key, []);
  }
  store.get(key).push(fn);
}

function removeListener(store, type, fn) {
  const list = store.get(String(type));
  if (!list) {
    return;
  }
  const index = list.indexOf(fn);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

function emit(store, target, event) {
  if (!event.target) {
    event.target = target;
  }
  event.currentTarget = target;
  const list = store.get(event.type);
  if (!list) {
    return !event.defaultPrevented;
  }
  for (const fn of list.slice()) {
    fn.call(target, event);
    if (event._immediateStopped) {
      break;
    }
  }
  return !event.defaultPrevented;
}

/* ------------------------------ DOM 节点 ------------------------------ */

class ClassList {
  constructor(el) {
    this._el = el;
  }

  _set() {
    return this._el._classes;
  }

  add() {
    for (const name of arguments) {
      if (name) {
        this._set().add(String(name));
      }
    }
  }

  remove() {
    for (const name of arguments) {
      this._set().delete(String(name));
    }
  }

  contains(name) {
    return this._set().has(String(name));
  }

  toggle(name, force) {
    const key = String(name);
    if (force === undefined) {
      if (this._set().has(key)) {
        this._set().delete(key);
        return false;
      }
      this._set().add(key);
      return true;
    }
    if (force) {
      this._set().add(key);
      return true;
    }
    this._set().delete(key);
    return false;
  }

  get length() {
    return this._set().size;
  }

  item(index) {
    return Array.from(this._set())[index] || null;
  }

  toString() {
    return Array.from(this._set()).join(' ');
  }
}

class DomText {
  constructor(doc, data) {
    this.ownerDocument = doc;
    this.nodeType = 3;
    this.nodeName = '#text';
    this.parentNode = null;
    this._data = data === undefined ? '' : String(data);
  }

  get textContent() {
    return this._data;
  }

  set textContent(value) {
    this._data = value === undefined || value === null ? '' : String(value);
  }

  get nodeValue() {
    return this._data;
  }

  set nodeValue(value) {
    this.textContent = value;
  }

  get data() {
    return this._data;
  }

  set data(value) {
    this.textContent = value;
  }

  get isConnected() {
    return isAttached(this);
  }

  get innerHTML() {
    return escapeText(this._data);
  }

  set innerHTML(value) {
    this._data = value === undefined || value === null ? '' : String(value);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  cloneNode() {
    return new DomText(this.ownerDocument, this._data);
  }
}

class DomElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.parentNode = null;
    this._children = [];
    this._attrs = new Map();
    this._classes = new Set();
    this._listeners = new Map();
    this._rawHtml = '';
    this.classList = new ClassList(this);

    // 常用 HTMLElement 属性：chat.js 直接当普通字段读写。
    this.style = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.placeholder = '';
    this.title = '';
    this.type = '';
    this.src = '';
    this.alt = '';
    this.loading = '';
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.scrollWidth = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
  }

  /* ----- 标识 ----- */
  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set className(value) {
    this._classes = new Set(
      String(value === undefined || value === null ? '' : value)
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  /* ----- 树 ----- */
  get childNodes() {
    return this._children;
  }

  get children() {
    return this._children.filter(function (child) {
      return child.nodeType === 1;
    });
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstChild() {
    return this._children[0] || null;
  }

  get lastChild() {
    return this._children[this._children.length - 1] || null;
  }

  get firstElementChild() {
    return firstElementChildOf(this);
  }

  get lastElementChild() {
    return lastElementChild(this);
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }
    const siblings = this.parentNode._children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) {
      return null;
    }
    const siblings = this.parentNode._children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  get isConnected() {
    return isAttached(this);
  }

  _detachChildren() {
    for (const child of this._children) {
      child.parentNode = null;
    }
    this._children = [];
  }

  appendChild(node) {
    if (!node) {
      return node;
    }
    if (node.nodeType === 11) {
      const kids = node._children.slice();
      node._children = [];
      for (const child of kids) {
        child.parentNode = null;
        this.appendChild(child);
      }
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    this._children.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore(node, reference) {
    if (!node) {
      return node;
    }
    if (reference === undefined || reference === null) {
      return this.appendChild(node);
    }
    if (node.nodeType === 11) {
      const kids = node._children.slice();
      node._children = [];
      for (const child of kids) {
        child.parentNode = null;
        this.insertBefore(child, reference);
      }
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    const index = this._children.indexOf(reference);
    if (index < 0) {
      throw new Error('insertBefore: reference node is not a child');
    }
    this._children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this._children.indexOf(node);
    if (index < 0) {
      throw new Error('removeChild: node is not a child');
    }
    this._children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChild(next, previous) {
    this.insertBefore(next, previous);
    this.removeChild(previous);
    return previous;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  /* ----- 内容 ----- */
  get textContent() {
    return this._children
      .map(function (child) {
        return child.textContent;
      })
      .join('');
  }

  set textContent(value) {
    this._detachChildren();
    this._rawHtml = '';
    const text = value === undefined || value === null ? '' : String(value);
    if (text !== '') {
      this.appendChild(this.ownerDocument.createTextNode(text));
    }
  }

  get innerHTML() {
    if (this._children.length === 0) {
      return this._rawHtml;
    }
    return this._children.map(serializeNode).join('');
  }

  set innerHTML(value) {
    this._detachChildren();
    this._rawHtml = value === undefined || value === null ? '' : String(value);
    // 只做「清空 + 纯文本」：把标签剥掉后保留可读文本，足够 textContent 断言。
    const text = decodeEntities(this._rawHtml.replace(/<[^>]*>/g, ''));
    if (text !== '') {
      this.appendChild(this.ownerDocument.createTextNode(text));
    }
  }

  /* ----- 属性 ----- */
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const raw = value === undefined || value === null ? '' : String(value);
    this._attrs.set(key, raw);
    if (key === 'class') {
      this.className = raw;
    }
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }

  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
  }

  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  /* ----- 选择器 ----- */
  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current && current.nodeType === 1) {
      if (matchesSelector(current, selector)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of collectDescendants(this)) {
      if (matchesSelector(child, selector)) {
        return child;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    return collectDescendants(this).filter(function (child) {
      return matchesSelector(child, selector);
    });
  }

  getElementsByTagName(tag) {
    return this.querySelectorAll(String(tag));
  }

  /* ----- 事件 ----- */
  addEventListener(type, fn) {
    addListener(this._listeners, type, fn);
  }

  removeEventListener(type, fn) {
    removeListener(this._listeners, type, fn);
  }

  dispatchEvent(event) {
    return emit(this._listeners, this, event);
  }

  click() {
    this.dispatchEvent(makeEvent('click'));
  }

  /* ----- 布局 / 焦点（全部无副作用） ----- */
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  getClientRects() {
    return [];
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  select() {}

  setSelectionRange() {}

  scrollIntoView() {}

  append() {
    for (const node of arguments) {
      this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
    }
  }

  cloneNode() {
    const copy = new DomElement(this.ownerDocument, this.tagName.toLowerCase());
    for (const [name, value] of this._attrs) {
      copy.setAttribute(name, value);
    }
    copy.className = this.className;
    for (const child of this._children) {
      copy.appendChild(child.cloneNode());
    }
    return copy;
  }
}

function isAttached(node) {
  let current = node;
  while (current) {
    if (current.nodeType === 9) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

class DomDocument {
  constructor() {
    this.nodeType = 9;
    this.nodeName = '#document';
    this._listeners = new Map();
    this._html = new DomElement(this, 'html');
    this._body = new DomElement(this, 'body');
    this._html.appendChild(this._body);
    // 让 isConnected/isAttached 能一路走到 document（nodeType 9）。
    this._html.parentNode = this;
    this.documentElement = this._html;
    this.body = this._body;
    this.head = new DomElement(this, 'head');
    this.activeElement = null;
  }

  createElement(tag) {
    return new DomElement(this, tag);
  }

  createTextNode(text) {
    return new DomText(this, text);
  }

  createDocumentFragment() {
    const fragment = new DomElement(this, 'fragment');
    fragment.nodeType = 11;
    fragment.nodeName = '#document-fragment';
    fragment.tagName = '#document-fragment';
    return fragment;
  }

  getElementById(id) {
    const wanted = String(id);
    const candidates = [this._html].concat(collectDescendants(this._html));
    for (const el of candidates) {
      if (el.getAttribute('id') === wanted) {
        return el;
      }
    }
    return null;
  }

  querySelector(selector) {
    const candidates = [this._html].concat(collectDescendants(this._html));
    for (const el of candidates) {
      if (matchesSelector(el, selector)) {
        return el;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    return [this._html].concat(collectDescendants(this._html)).filter(function (el) {
      return matchesSelector(el, selector);
    });
  }

  addEventListener(type, fn) {
    addListener(this._listeners, type, fn);
  }

  removeEventListener(type, fn) {
    removeListener(this._listeners, type, fn);
  }

  dispatchEvent(event) {
    return emit(this._listeners, this, event);
  }

  execCommand() {
    return false;
  }
}

/* ------------------------------ 可控时钟 ------------------------------ */

function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();

  function add(fn, delay, args, repeat) {
    const id = (seq += 1);
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, {
      id: id,
      fn: fn,
      args: args || [],
      delay: ms,
      due: now + ms,
      repeat: Boolean(repeat),
    });
    return id;
  }

  function clear(id) {
    timers.delete(id);
  }

  /**
   * 只跑「短延迟」的一次性任务：requestAnimationFrame 16ms、setTimeout(...,0)。
   * 500ms 的 setInterval(tickTurnDivider) 和 350ms 的 showPendingDelayed 不会被推进，
   * 保证测试确定且进程能退出。
   */
  function flush() {
    const errors = [];
    for (let step = 0; step < FLUSH_MAX_STEPS; step += 1) {
      let best = null;
      for (const timer of timers.values()) {
        if (timer.delay > FLUSH_MAX_DELAY) {
          continue;
        }
        if (timer.due > now + FLUSH_MAX_DELAY) {
          continue;
        }
        if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) {
          best = timer;
        }
      }
      if (!best) {
        return errors;
      }
      now = Math.max(now, best.due);
      if (best.repeat) {
        best.due = now + Math.max(1, best.delay);
      } else {
        timers.delete(best.id);
      }
      try {
        best.fn.apply(null, best.args);
      } catch (err) {
        errors.push(err);
      }
    }
    errors.push(new Error('flush 步数超过上限，疑似定时器自循环'));
    return errors;
  }

  return {
    setTimeout: function (fn, delay) {
      return add(fn, delay, Array.prototype.slice.call(arguments, 2), false);
    },
    setInterval: function (fn, delay) {
      return add(fn, delay, Array.prototype.slice.call(arguments, 2), true);
    },
    clearTimeout: clear,
    clearInterval: clear,
    requestAnimationFrame: function (fn) {
      return add(fn, 16, [now], false);
    },
    cancelAnimationFrame: clear,
    flush: flush,
    clearAll: function () {
      timers.clear();
    },
    get now() {
      return now;
    },
  };
}

/* ------------------------------ 页面初始化 ------------------------------ */

function buildPage(doc) {
  const app = doc.createElement('div');
  app.className = 'app';

  const messages = doc.createElement('div');
  messages.setAttribute('id', 'messages');
  messages.className = 'messages';
  const empty = doc.createElement('div');
  empty.setAttribute('id', 'empty');
  empty.className = 'empty';
  messages.appendChild(empty);
  app.appendChild(messages);

  // chat.js 里这些元素是可选的，但真实页面存在；这里保持同样的 id。
  const quickSkills = doc.createElement('div');
  quickSkills.setAttribute('id', 'quick-skills');
  quickSkills.className = 'quick-skills';
  app.appendChild(quickSkills);

  const quickChat = doc.createElement('div');
  quickChat.setAttribute('id', 'quick-chat');
  quickChat.className = 'quick-chat';
  for (const action of ['image', 'video', 'ppt']) {
    const btn = doc.createElement('button');
    btn.className = 'pill chat-action';
    btn.setAttribute('data-chat-action', action);
    btn.textContent = action;
    quickChat.appendChild(btn);
  }
  app.appendChild(quickChat);
  const quickVerify = doc.createElement('div');
  quickVerify.setAttribute('id', 'quick-verify');
  quickVerify.className = 'quick-chat';
  for (const kind of ['build', 'test']) {
    const btn = doc.createElement('button');
    btn.className = 'pill verify-action';
    btn.setAttribute('data-verify', kind);
    quickVerify.appendChild(btn);
  }
  app.appendChild(quickVerify);
  const mention = doc.createElement('button');
  mention.className = 'pill mention-action';
  mention.setAttribute('data-mention', 'file');
  mention.textContent = '@ 文件';
  app.appendChild(mention);

  const attachments = doc.createElement('div');
  attachments.setAttribute('id', 'attachments');
  attachments.className = 'attachments';
  attachments.hidden = true;
  app.appendChild(attachments);

  const input = doc.createElement('textarea');
  input.setAttribute('id', 'input');
  input.className = 'input';
  app.appendChild(input);

  const buttonIds = [
    'btn-send',
    'btn-stop',
    'btn-new',
    'btn-task',
    'btn-logs',
    'btn-settings',
    'btn-plus',
    'btn-more',
    'btn-history',
    'btn-overflow',
  ];
  for (const id of buttonIds) {
    const button = doc.createElement('button');
    button.setAttribute('id', id);
    button.className = 'btn ' + id;
    app.appendChild(button);
  }

  const meta = doc.createElement('div');
  meta.setAttribute('id', 'meta');
  app.appendChild(meta);

  const status = doc.createElement('div');
  status.setAttribute('id', 'status');
  app.appendChild(status);

  const contextHint = doc.createElement('div');
  contextHint.setAttribute('id', 'context-hint');
  app.appendChild(contextHint);

  const chipIds = [
    'chip-mode',
    'chip-project',
    'chip-permission',
    'chip-skills',
    'chip-plugins',
    'chip-model',
  ];
  for (const id of chipIds) {
    const chip = doc.createElement('button');
    chip.setAttribute('id', id);
    chip.className = 'chip ' + id;
    app.appendChild(chip);
  }

  doc.body.appendChild(app);
  return { app, messages, empty, input };
}

/* ------------------------------ 对外入口 ------------------------------ */

function createHarness() {
  const doc = new DomDocument();
  const page = buildPage(doc);
  const clock = createClock();
  const posted = [];
  let savedState;

  const vscodeApi = {
    postMessage: function (message) {
      posted.push(message);
    },
    setState: function (value) {
      savedState = value;
    },
    getState: function () {
      return savedState;
    },
  };

  const windowListeners = new Map();
  const windowObj = {
    addEventListener: function (type, fn) {
      addListener(windowListeners, type, fn);
    },
    removeEventListener: function (type, fn) {
      removeListener(windowListeners, type, fn);
    },
    dispatchEvent: function (event) {
      return emit(windowListeners, windowObj, event);
    },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    location: { href: 'vscode-webview://ui-states', protocol: 'vscode-webview:' },
  };

  const sandbox = {
    window: windowObj,
    document: doc,
    navigator: { userAgent: 'ui-states-harness', clipboard: { writeText: async function () {} } },
    acquireVsCodeApi: function () {
      return vscodeApi;
    },
    console: console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    btoa: function (value) {
      return Buffer.from(String(value), 'binary').toString('base64');
    },
    atob: function (value) {
      return Buffer.from(String(value), 'base64').toString('binary');
    },
  };

  function load(source, filename) {
    const context = vm.createContext(sandbox);
    // 同步执行整个 IIFE；语法错误/启动异常会直接抛给测试。
    vm.runInContext(source, context, {
      filename: filename || 'media/chat.js',
      timeout: 10000,
    });
    return context;
  }

  function send(message) {
    const errors = [];
    try {
      emit(windowListeners, windowObj, makeEvent('message', { data: message }));
    } catch (err) {
      errors.push(err);
    }
    for (const err of clock.flush()) {
      errors.push(err);
    }
    return errors;
  }

  return {
    document: doc,
    window: windowObj,
    body: doc.body,
    messages: page.messages,
    empty: page.empty,
    input: page.input,
    posted: posted,
    vscode: vscodeApi,
    context: null,
    load: function (source, filename) {
      const context = load(source, filename);
      this.context = context;
      return context;
    },
    send: send,
    flush: function () {
      return clock.flush();
    },
    byId: function (id) {
      return doc.getElementById(id);
    },
    query: function (selector) {
      return doc.querySelector(selector);
    },
    queryAll: function (selector) {
      return doc.querySelectorAll(selector);
    },
    dispose: function () {
      clock.clearAll();
    },
  };
}

module.exports = {
  createHarness: createHarness,
};
