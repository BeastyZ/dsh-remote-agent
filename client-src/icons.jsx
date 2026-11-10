import { h } from './runtime.js';

const base = { display: 'block', flex: 'none' };

function svg(props, children) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: props.size || 16,
    height: props.size || 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: props.strokeWidth || 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { ...base, ...(props.style || {}) },
  }, children);
}

export function ServerIcon(props = {}) {
  return svg(props, [
    h('rect', { key: 'a', x: 3, y: 3.5, width: 18, height: 7, rx: 2 }),
    h('rect', { key: 'b', x: 3, y: 13.5, width: 18, height: 7, rx: 2 }),
    h('path', { key: 'c', d: 'M7 7h.01M7 17h.01M11 7h5M11 17h5' }),
  ]);
}

export function TerminalIcon(props = {}) {
  return svg(props, [
    h('rect', { key: 'a', x: 2.5, y: 4, width: 19, height: 14, rx: 2.5 }),
    h('path', { key: 'b', d: 'M6.5 9l3 3-3 3M12 15h5' }),
  ]);
}

export function FolderIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M3 7.5A2.5 2.5 0 015.5 5h3.2l2 2.2h7.8A2.5 2.5 0 0121 9.7v7.8A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5z' }),
  ]);
}

export function FolderOpenIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M3 8V6.5A2.5 2.5 0 015.5 4h3.2l2 2.2h7.8A2.5 2.5 0 0121 8.7V10' }),
    h('path', { key: 'b', d: 'M3.5 10h18l-2.2 8.2A2 2 0 0117.4 20H5.2a2 2 0 01-1.9-2.5z' }),
  ]);
}

export function FileIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M6 3.5h7.5L19 9v11.5H6z' }),
    h('path', { key: 'b', d: 'M13.5 3.5V9H19' }),
  ]);
}

export function ImageIcon(props = {}) {
  return svg(props, [
    h('rect', { key: 'a', x: 3, y: 4.5, width: 18, height: 15, rx: 2 }),
    h('circle', { key: 'b', cx: 8.5, cy: 9.5, r: 1.5 }),
    h('path', { key: 'c', d: 'M21 16l-5-5-4.5 4.5L9 13l-6 6' }),
  ]);
}

export function CodeIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M8.5 8.5L4.5 12l4 3.5M15.5 8.5l4 3.5-4 3.5M13.5 5.5l-3 13' }),
  ]);
}

export function PlayIcon(props = {}) {
  return svg({ ...props, fill: 'currentColor', strokeWidth: 0 }, [
    h('path', { key: 'a', d: 'M8 5.5v13l11-6.5z' }),
  ]);
}

export function PlusIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })]);
}

export function RefreshIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6' }),
  ]);
}

export function SettingsIcon(props = {}) {
  return svg(props, [
    h('circle', { key: 'a', cx: 12, cy: 12, r: 3 }),
    h('path', { key: 'b', d: 'M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' }),
  ]);
}

export function ChevronIcon({ open, size = 14, style }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    style: { flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease', ...(style || {}) },
  }, h('path', { d: 'M9 5l7 7-7 7' }));
}

export function CloseIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })]);
}

export function SaveIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M5 4h11l3 3v13H5z' }),
    h('path', { key: 'b', d: 'M8 4v6h8V4M8 20v-6h8v6' }),
  ]);
}

export function CopyIcon(props = {}) {
  return svg(props, [
    h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
    h('path', { key: 'b', d: 'M15 5.5A1.5 1.5 0 0013.5 4H5.5A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15' }),
  ]);
}

export function TrashIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5' }),
  ]);
}

export function EditIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4' })]);
}

export function EyeIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z' }),
    h('circle', { key: 'b', cx: 12, cy: 12, r: 2.6 }),
  ]);
}

export function BackIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M15 5l-7 7 7 7' })]);
}

export function SearchIcon(props = {}) {
  return svg(props, [
    h('circle', { key: 'a', cx: 10.5, cy: 10.5, r: 6 }),
    h('path', { key: 'b', d: 'M15 15l5 5' }),
  ]);
}

export function PlugIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 01-6 6 6 6 0 01-6-6zM12 17v4' }),
  ]);
}

export function LockIcon(props = {}) {
  return svg(props, [
    h('rect', { key: 'a', x: 5, y: 10, width: 14, height: 10, rx: 2 }),
    h('path', { key: 'b', d: 'M8 10V7.5a4 4 0 018 0V10' }),
  ]);
}

export function UploadIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M12 16V4M7 9l5-5 5 5M4 16v3.5h16V16' }),
  ]);
}

export function DownloadIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M12 4v12M7 11l5 5 5-5M4 20h16' })]);
}

export function Dot({ state, size = 7 }) {
  const color = state === 'online' ? 'var(--dsw-alias-state-success-primary)'
    : state === 'connecting' ? 'var(--dsw-alias-state-warn-primary)'
      : state === 'offline' || state === 'error' ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-idle-primary)';
  return h('span', {
    style: {
      width: size, height: size, borderRadius: '50%', background: color, flex: 'none',
      boxShadow: state === 'connecting' ? '0 0 0 3px color-mix(in srgb, currentColor 18%, transparent)' : 'none',
    },
  });
}

export function Spinner({ size = 14 }) {
  return h('span', {
    style: {
      width: size, height: size, borderRadius: '50%', flex: 'none',
      border: '2px solid var(--dsw-alias-border-l2)', borderTopColor: 'var(--dsw-alias-brand-primary)',
      animation: 'ra-spin .7s linear infinite', display: 'inline-block',
    },
  });
}

export function BranchIcon(props = {}) {
  return svg(props, [
    h('circle', { key: 'a', cx: 6.5, cy: 5.5, r: 2.2 }),
    h('circle', { key: 'b', cx: 6.5, cy: 18.5, r: 2.2 }),
    h('circle', { key: 'c', cx: 17.5, cy: 8.5, r: 2.2 }),
    h('path', { key: 'd', d: 'M6.5 7.7v8.6M8.7 6.2h3.6a3 3 0 013 3v1.1' }),
  ]);
}

export function CheckIcon(props = {}) {
  return svg(props, [h('path', { key: 'a', d: 'M4.5 12.5l5 5 10-11' })]);
}

export function LinkIcon(props = {}) {
  return svg(props, [
    h('path', { key: 'a', d: 'M10 13.5a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1.4 1.4' }),
    h('path', { key: 'b', d: 'M14 10.5a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1.4-1.4' }),
  ]);
}
