import { React, h } from './runtime.js';
import { t } from './runtime.js';
import { CloseIcon, Spinner } from './icons.jsx';

export function usePortal(node) {
  const dom = React.useMemo(() => document.createElement('div'), []);
  React.useEffect(() => {
    dom.className = 'ra-portal';
    document.body.appendChild(dom);
    return () => { dom.remove(); };
  }, [dom]);
  const portal = ReactDOM?.createPortal;
  return portal ? portal(node, dom) : node;
}

let ReactDOM = null;
export function setReactDOM(value) { ReactDOM = value; }
export function hasPortal() { return Boolean(ReactDOM && ReactDOM.createPortal); }

export function Portal({ children }) {
  if (hasPortal()) return ReactDOM.createPortal(children, document.body);
  return children;
}

export function formatBytes(n, tr = t) {
  const value = Number(n) || 0;
  if (value < 1024) return tr('misc.bytes', { n: value });
  if (value < 1024 * 1024) return tr('misc.kb', { n: (value / 1024).toFixed(value < 10240 ? 1 : 0) });
  if (value < 1024 * 1024 * 1024) return tr('misc.mb', { n: (value / 1024 / 1024).toFixed(1) });
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function basename(p) {
  const s = String(p || '').replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || '/';
}
export function dirname(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
export function joinPath(dir, name) {
  return String(dir || '').replace(/\/+$/, '') + '/' + String(name || '').replace(/^\/+/, '');
}
export function extname(name) {
  const base = basename(name);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}
export function classifyFile(name) {
  const ext = extname(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'].includes(ext)) return 'image';
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'mkv', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'whl', 'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'pyc', 'pt', 'pth', 'ckpt', 'safetensors', 'onnx', 'npy', 'npz', 'parquet'].includes(ext)) return 'binary';
  return 'text';
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
};
export function mimeOf(name) {
  const ext = extname(name);
  return MIME[ext] || 'application/octet-stream';
}

export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function downloadBase64(name, base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

export function IconButton({ title, onClick, children, active, disabled, danger, size }) {
  return h('button', {
    type: 'button',
    className: 'ra-iconbtn' + (active ? ' is-active' : '') + (danger ? ' is-danger' : ''),
    title,
    'aria-label': title,
    onClick,
    disabled,
    style: size ? { width: size, height: size } : undefined,
  }, children);
}

export function Button({ children, onClick, variant = 'default', disabled, title, type = 'button', style }) {
  return h('button', {
    type,
    className: 'ra-btn ra-btn-' + variant,
    onClick,
    disabled,
    title,
    style,
  }, children);
}

export function SpinnerText({ label }) {
  return h('span', { className: 'ra-inline-spinner' }, h(Spinner, { size: 12 }), h('span', null, label));
}

export function Modal({ title, subtitle, children, footer, onClose, width = 560, closable = true }) {
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && closable) { event.stopPropagation(); onClose?.(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, closable]);

  const body = h('div', {
    className: 'ra-modal-mask',
    onMouseDown: (event) => { if (event.target === event.currentTarget && closable) onClose?.(); },
  }, h('div', {
    className: 'ra-modal',
    style: { width },
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  },
  h('div', { className: 'ra-modal-head' },
    h('div', null,
      h('div', { className: 'ra-modal-title' }, title),
      subtitle ? h('div', { className: 'ra-modal-sub' }, subtitle) : null),
    closable ? h(IconButton, { title: t('misc.close'), onClick: onClose }, h(CloseIcon, { size: 16 })) : null),
  h('div', { className: 'ra-modal-body' }, children),
  footer ? h('div', { className: 'ra-modal-foot' }, footer) : null));

  return h(Portal, null, body);
}

export function Toast({ toast, onClose }) {
  React.useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => onClose?.(), toast.duration || 3200);
    return () => clearTimeout(timer);
  }, [toast, onClose]);
  if (!toast) return null;
  return h(Portal, null, h('div', { className: 'ra-toast ' + (toast.kind || 'info'), role: 'status' },
    h('span', { className: 'ra-toast-dot' }),
    h('span', null, toast.message)));
}

// ---------------------------------------------------------------------------
// A compact markdown renderer (no dangerouslySetInnerHTML).
// ---------------------------------------------------------------------------
function safeHref(url) {
  const value = String(url || '').trim();
  if (/^(https?:|mailto:|#)/i.test(value)) return value;
  return null;
}

function inline(text, keyPrefix = 'i') {
  const nodes = [];
  const source = String(text || '');
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(source))) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
    else if (token.startsWith('~~')) nodes.push(h('del', { key }, token.slice(2, -2)));
    else if (token.startsWith('`')) nodes.push(h('code', { key, className: 'ra-md-code' }, token.slice(1, -1)));
    else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = safeHref(token.slice(close + 2, -1));
      nodes.push(href
        ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, label)
        : label);
    } else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

export function Markdown({ text }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(h('pre', { key: 'b' + key++, className: 'ra-md-pre' }, h('code', null, body.join('\n'))));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(h('h' + level, { key: 'b' + key++, className: 'ra-md-h ra-md-h' + level }, inline(heading[2], 'h' + key)));
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(h('hr', { key: 'b' + key++, className: 'ra-md-hr' }));
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(h('blockquote', { key: 'b' + key++, className: 'ra-md-quote' }, inline(body.join('\n'), 'q' + key)));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      blocks.push(h('ul', { key: 'b' + key++, className: 'ra-md-ul' }, items.map((item, index) => h('li', { key: 'li' + index }, inline(item, 'li' + index)))));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      blocks.push(h('ol', { key: 'b' + key++, className: 'ra-md-ol' }, items.map((item, index) => h('li', { key: 'li' + index }, inline(item, 'li' + index)))));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(parseRow(lines[i++]));
      blocks.push(h('div', { key: 'b' + key++, className: 'ra-md-table-wrap' }, h('table', { className: 'ra-md-table' },
        h('thead', null, h('tr', null, header.map((cell, index) => h('th', { key: index }, inline(cell, 'th' + index))))),
        h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, inline(cell, `td${rowIndex}-${cellIndex}`)))))))));
      continue;
    }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*\|.*\|\s*$)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(h('p', { key: 'b' + key++, className: 'ra-md-p' }, inline(para.join('\n'), 'p' + key)));
  }
  if (!blocks.length) return h('div', { className: 'ra-md-empty' }, '—');
  return h('div', { className: 'ra-md' }, blocks);
}
