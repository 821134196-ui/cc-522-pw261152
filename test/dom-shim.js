// Minimal DOM used by the headless render tests. Not a browser: enough of the
// Node/Element surface for app.js to build and serialize its tree, so the real
// render functions are exercised instead of a mock view layer.

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  get value() {
    return [...this.set].join(' ');
  }
  toString() {
    return this.value;
  }
}

class Style {
  constructor() {
    this.props = new Map();
  }
  setProperty(key, value) {
    this.props.set(key, String(value));
  }
  getPropertyValue(key) {
    return this.props.get(key) || '';
  }
  get cssText() {
    return [...this.props].map(([k, v]) => `${k}: ${v}`).join('; ');
  }
}

export class Node {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof Node ? node : new Text(this.ownerDocument, String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    if (value !== '') this.append(new Text(this.ownerDocument, String(value)));
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  addEventListener(type, fn) {
    this.listeners = this.listeners || new Map();
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const fn of this.listeners?.get(type) || []) {
      fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  click() {
    this.dispatch('click');
  }
  focus() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
  scrollIntoView() {}
  setAttribute(name, value) {
    this.attributes = this.attributes || new Map();
    this.attributes.set(name, String(value));
    if (name === 'class') this._className = String(value);
    if (name === 'style') this.attributes.set('style', String(value));
  }
  getAttribute(name) {
    return this.attributes?.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes?.delete(name);
  }
}

export class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
  get outerHTML() {
    return escapeHtml(this.data);
  }
}

export class Element extends Node {
  constructor(doc, tagName, namespace = null) {
    super(doc);
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespace;
    this.classList = new ClassList();
    this.style = new Style();
    this.attributes = new Map();
    this.dataset = {};
    this.value = '';
  }
  get className() {
    return this.classList.value;
  }
  set className(value) {
    this.classList = new ClassList();
    for (const n of String(value).split(/\s+/)) if (n) this.classList.add(n);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(value) {
    this.setAttribute('id', value);
  }
  matches(selector) {
    return matches(this, selector);
  }
  get outerHTML() {
    const attrs = [];
    const cls = this.className;
    if (cls) attrs.push(`class="${escapeAttr(cls)}"`);
    if (this.id) attrs.push(`id="${escapeAttr(this.id)}"`);
    for (const [k, v] of this.attributes) {
      if (k === 'class' || k === 'id' || k === 'style') continue;
      attrs.push(`${k}="${escapeAttr(v)}"`);
    }
    if (this.style.cssText) attrs.push(`style="${escapeAttr(this.style.cssText)}"`);
    const open = `<${this.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    const close = `</${this.tagName.toLowerCase()}>`;
    return `${open}${this.childNodes.map((n) => n.outerHTML).join('')}${close}`;
  }
}

function matches(element, selector) {
  if (!(element instanceof Element)) return false;
  for (const part of selector.split(',').map((s) => s.trim())) {
    if (part.startsWith('.')) {
      if (element.classList.contains(part.slice(1))) return true;
    } else if (part.startsWith('#')) {
      if (element.id === part.slice(1)) return true;
    } else if (/^[a-z0-9]+$/i.test(part)) {
      if (element.tagName === part.toUpperCase()) return true;
    }
  }
  return false;
}

export class Document extends Node {
  constructor() {
    super(null);
    this.documentElement = new Element(this, 'html');
    this.documentElement.ownerDocument = this;
    this.body = new Element(this, 'body');
    this.body.ownerDocument = this;
    this.documentElement.append(this.body);
    this.append(this.documentElement);
    this.listeners = new Map();
    const appRoot = new Element(this, 'div');
    appRoot.id = 'app';
    this.body.append(appRoot);
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  createElementNS(ns, tag) {
    return new Element(this, tag, ns);
  }
  createTextNode(text) {
    return new Text(this, String(text));
  }
  getElementById(id) {
    return this.querySelectorAll(`#${id}`)[0] || null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

export function installDom() {
  const document = new Document();
  const window = {
    document,
    location: { hash: '' },
    localStorage: {
      store: new Map(),
      getItem(k) {
        return this.store.has(k) ? this.store.get(k) : null;
      },
      setItem(k, v) {
        this.store.set(k, String(v));
      },
    },
    addEventListener() {},
    requestAnimationFrame(fn) {
      return setTimeout(fn, 0);
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = window.localStorage;
  globalThis.location = window.location;
  globalThis.Node = Node;
  globalThis.Element = Element;
  globalThis.HTMLElement = Element;
  globalThis.Text = Text;
  globalThis.history = { replaceState() {} };
  return { document, window };
}
