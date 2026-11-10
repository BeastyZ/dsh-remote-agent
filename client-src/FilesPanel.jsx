import { React, h, t } from './runtime.js';
import {
  BackIcon, ChevronIcon, CodeIcon, CopyIcon, DownloadIcon, EditIcon, EyeIcon, FileIcon,
  FolderIcon, FolderOpenIcon, ImageIcon, PlusIcon, RefreshIcon, SaveIcon, SearchIcon, TrashIcon, UploadIcon,
} from './icons.jsx';
import {
  Button, IconButton, Markdown, Modal, basename, classifyFile, copyText, dirname, downloadBase64,
  extname, formatBytes, joinPath, mimeOf, toBase64,
} from './ui.jsx';

function iconFor(entry) {
  if (entry.type === 'dir') return FolderIcon;
  const kind = classifyFile(entry.name);
  if (kind === 'image') return ImageIcon;
  if (kind === 'markdown' || kind === 'text') return CodeIcon;
  return FileIcon;
}

function isImage(name) { return classifyFile(name) === 'image'; }
function isPdf(name) { return classifyFile(name) === 'pdf'; }
function isVideo(name) { return classifyFile(name) === 'video'; }
function isAudio(name) { return classifyFile(name) === 'audio'; }
function isHtml(name) { return classifyFile(name) === 'html'; }
function isMarkdown(name) { return classifyFile(name) === 'markdown'; }

function visibleEntries(entries) {
  return (entries || []).filter((entry) => !['.git', '.hg', '.svn'].includes(entry.name));
}

export function FilesPanel({ hostId, workspace, rpc, notify, onRevealInTerminal }) {
  const root = workspace.path;
  const [expanded, setExpanded] = React.useState(() => new Set([root]));
  const [dirs, setDirs] = React.useState({});
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [menu, setMenu] = React.useState(null);
  const [clipboard, setClipboard] = React.useState(null);
  const [openFile, setOpenFile] = React.useState(null);
  const [prompt, setPrompt] = React.useState(null);
  const [confirm, setConfirm] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const uploadRef = React.useRef(null);

  const loadDir = React.useCallback(async (path, { force = false } = {}) => {
    if (!force && dirs[path] && dirs[path].entries) return;
    setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] || {}), loading: true, error: null } }));
    try {
      const result = await rpc('fs.list', { hostId, path });
      if (!result.ok) throw new Error(result.message || 'list failed');
      setDirs((prev) => ({ ...prev, [path]: { loading: false, entries: result.entries, error: null, truncated: Boolean(result.truncated) } }));
    } catch (error) {
      setDirs((prev) => ({ ...prev, [path]: { loading: false, entries: prev[path]?.entries || null, error: error.message } }));
    }
  }, [hostId, rpc, dirs]);

  React.useEffect(() => {
    setExpanded(new Set([root]));
    setDirs({});
    setOpenFile(null);
    loadDir(root, { force: true });
  }, [hostId, root]);

  React.useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const refresh = () => {
    loadDir(root, { force: true });
    for (const path of expanded) {
      if (path !== root) loadDir(path, { force: true });
    }
  };

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        loadDir(path);
      }
      return next;
    });
  };

  const openEntry = async (entry) => {
    if (entry.type === 'dir') { toggle(entry.path); return; }
    setOpenFile({ path: entry.path, name: entry.name, size: entry.size, mtime: entry.mtime, loading: true });
    try {
      const kind = classifyFile(entry.name);
      const maxBytes = kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio' ? 24 * 1024 * 1024 : 4 * 1024 * 1024;
      const result = await rpc('fs.read', { hostId, path: entry.path, maxBytes });
      if (!result.ok) throw new Error(result.message || 'read failed');
      setOpenFile({ ...result, name: entry.name, loading: false, kind });
    } catch (error) {
      setOpenFile({ path: entry.path, name: entry.name, loading: false, error: error.message, kind: 'text' });
    }
  };

  const relative = (path) => {
    const base = root.replace(/\/+$/, '');
    return path === base ? '' : path.startsWith(base + '/') ? path.slice(base.length + 1) : path;
  };

  const copy = async (text) => {
    const ok = await copyText(text);
    notify(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'success' : 'error');
  };

  const refreshAll = async () => {
    await loadDir(root, { force: true });
    for (const path of expanded) if (path !== root) await loadDir(path, { force: true });
  };

  const doCreate = async (parent, name, type) => {
    const target = joinPath(parent, name);
    try {
      if (type === 'dir') {
        const result = await rpc('fs.mkdir', { hostId, path: target });
        if (!result.ok) throw new Error(result.message);
      } else {
        const result = await rpc('fs.write', { hostId, path: target, base64: '', expectedMtime: null });
        if (!result.ok) throw new Error(result.message);
      }
      notify(t('toast.created') + ': ' + name, 'success');
      await loadDir(parent, { force: true });
      if (type === 'file') openEntry({ name, path: target, type: 'file', size: 0 });
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const doRename = async (entry, name) => {
    if (!name || name === entry.name) return;
    try {
      const result = await rpc('fs.rename', { hostId, from: entry.path, to: joinPath(dirname(entry.path), name) });
      if (!result.ok) throw new Error(result.message);
      notify(t('toast.renamed'), 'success');
      refreshAll();
      if (openFile && openFile.path === entry.path) setOpenFile(null);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const doDelete = async (entry) => {
    try {
      const result = await rpc('fs.remove', { hostId, path: entry.path });
      if (!result.ok) throw new Error(result.message);
      notify(t('toast.deleted'), 'success');
      if (openFile && openFile.path === entry.path) setOpenFile(null);
      refreshAll();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const doPaste = async (destDir) => {
    if (!clipboard || clipboard.hostId !== hostId) return;
    try {
      const result = await rpc('fs.transfer', {
        hostId, sources: clipboard.paths, destDir, move: clipboard.op === 'cut',
      });
      if (!result.ok) throw new Error(result.message);
      notify(t('toast.pasted'), 'success');
      setClipboard(null);
      await loadDir(destDir, { force: true });
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const upload = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) { notify(t('files.tooLarge'), 'error'); return; }
    setBusy(t('files.uploading'));
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      const result = await rpc('fs.write', {
        hostId, path: joinPath(openFile ? dirname(openFile.path) : root, file.name), base64: btoa(binary), expectedMtime: null,
      });
      if (!result.ok) throw new Error(result.message);
      notify(t('toast.created') + ': ' + file.name, 'success');
      refreshAll();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const menuItems = (entry, parentPath) => {
    const items = [];
    if (entry) {
      items.push({ id: 'open', label: entry.type === 'dir' ? t('files.open') : t('files.edit'), icon: EditIcon, run: () => openEntry(entry) });
      if (entry.type === 'dir') {
        items.push({ id: 'newFile', label: t('files.newFile'), icon: PlusIcon, run: () => setPrompt({ kind: 'newFile', parent: entry.path, value: '' }) });
        items.push({ id: 'newFolder', label: t('files.newFolder'), icon: PlusIcon, run: () => setPrompt({ kind: 'newFolder', parent: entry.path, value: '' }) });
        items.push({ id: 'paste', label: t('files.paste'), icon: CopyIcon, disabled: !clipboard || clipboard.hostId !== hostId, run: () => doPaste(entry.path) });
        items.push({ type: 'sep' });
      }
      items.push({ id: 'rename', label: t('files.rename'), icon: EditIcon, run: () => setPrompt({ kind: 'rename', entry, value: entry.name }) });
      items.push({ id: 'copy', label: t('files.copy'), icon: CopyIcon, run: () => { setClipboard({ hostId, paths: [entry.path], op: 'copy' }); notify(t('toast.copied'), 'success'); } });
      items.push({ id: 'cut', label: t('files.cut'), icon: CopyIcon, run: () => { setClipboard({ hostId, paths: [entry.path], op: 'cut' }); notify(t('toast.copied'), 'success'); } });
      items.push({ type: 'sep' });
      items.push({ id: 'copyPath', label: t('files.copyPath'), icon: CopyIcon, run: () => copy(entry.path) });
      items.push({ id: 'copyRelative', label: t('files.copyRelative'), icon: CopyIcon, run: () => copy(relative(entry.path)) });
      if (entry.type === 'file') {
        items.push({ id: 'download', label: t('files.download'), icon: DownloadIcon, run: async () => {
          try {
            const result = await rpc('fs.read', { hostId, path: entry.path, maxBytes: 24 * 1024 * 1024 });
            if (!result.ok) throw new Error(result.message);
            if (!result.base64) throw new Error(result.message || t('files.tooLarge'));
            downloadBase64(entry.name, result.base64, mimeOf(entry.name));
          } catch (error) { notify(error.message, 'error'); }
        } });
      }
      items.push({ id: 'reveal', label: t('files.openInTerminal'), icon: CodeIcon, run: () => onRevealInTerminal?.(entry.type === 'dir' ? entry.path : dirname(entry.path)) });
      items.push({ type: 'sep' });
      items.push({ id: 'delete', label: t('files.delete'), icon: TrashIcon, danger: true, run: () => setConfirm({ entry }) });
    } else {
      items.push({ id: 'newFile', label: t('files.newFile'), icon: PlusIcon, run: () => setPrompt({ kind: 'newFile', parent: parentPath, value: '' }) });
      items.push({ id: 'newFolder', label: t('files.newFolder'), icon: PlusIcon, run: () => setPrompt({ kind: 'newFolder', parent: parentPath, value: '' }) });
      items.push({ id: 'paste', label: t('files.paste'), icon: CopyIcon, disabled: !clipboard || clipboard.hostId !== hostId, run: () => doPaste(parentPath) });
      items.push({ type: 'sep' });
      items.push({ id: 'upload', label: t('files.upload'), icon: UploadIcon, run: () => uploadRef.current?.click() });
      items.push({ id: 'refresh', label: t('files.refresh'), icon: RefreshIcon, run: refresh });
    }
    return items;
  };

  const openMenu = (event, entry, parentPath) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 230;
    const height = 360;
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
      entry,
      parentPath,
    });
  };

  const renderRow = (entry, depth) => {
    const Icon = iconFor(entry);
    const isDir = entry.type === 'dir';
    const isOpen = isDir && expanded.has(entry.path);
    const selected = openFile && openFile.path === entry.path;
    const node = dirs[entry.path];
    const children = [];
    children.push(h('div', {
      key: 'row',
      className: 'ra-tree-row' + (selected ? ' is-selected' : ''),
      style: { paddingLeft: 8 + depth * 13 + 'px' },
      onClick: () => openEntry(entry),
      onContextMenu: (event) => openMenu(event, entry, isDir ? entry.path : dirname(entry.path)),
      title: entry.path,
    },
    isDir
      ? h('span', { className: 'ra-tree-chevron' }, h(ChevronIcon, { open: isOpen, size: 12 }))
      : h('span', { className: 'ra-tree-chevron' }),
    h(Icon, { size: 15, style: { color: isDir ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' } }),
    h('span', { className: 'ra-tree-name' }, entry.name),
    h('span', { className: 'ra-tree-meta' }, isDir || entry.size == null ? '' : formatBytes(entry.size, t))));

    if (isDir && isOpen) {
      if (node && node.loading) children.push(h('div', { key: 'loading', className: 'ra-tree-note', style: { paddingLeft: 26 + depth * 13 + 'px' } }, t('files.loading')));
      else if (node && node.error) children.push(h('div', { key: 'err', className: 'ra-tree-note is-error', style: { paddingLeft: 26 + depth * 13 + 'px' } }, node.error));
      else if (node && node.entries && node.entries.length === 0) children.push(h('div', { key: 'empty', className: 'ra-tree-note', style: { paddingLeft: 26 + depth * 13 + 'px' } }, t('files.emptyDir')));
      else if (node && node.entries) {
        for (const child of visibleEntries(node.entries)) {
          children.push(h('div', { key: child.path }, renderRow(child, depth + 1)));
        }
      }
    }
    return children;
  };

  const rootNode = dirs[root];
  const rootEntries = rootNode && rootNode.entries ? visibleEntries(rootNode.entries) : null;

  return h('div', { className: 'ra-files' },
    h('div', { className: 'ra-panel-head' },
      h('div', { className: 'ra-panel-title' }, h('span', null, t('files.title')), h('span', { className: 'ra-count' }, workspace.name)),
      h('div', { className: 'ra-head-actions' },
        h(IconButton, { title: t('files.newFile'), onClick: () => setPrompt({ kind: 'newFile', parent: openFile ? dirname(openFile.path) : root, value: '' }) }, h(PlusIcon, { size: 15 })),
        h(IconButton, { title: t('files.newFolder'), onClick: () => setPrompt({ kind: 'newFolder', parent: openFile ? dirname(openFile.path) : root, value: '' }) }, h(FolderIcon, { size: 15 })),
        h(IconButton, { title: t('files.upload'), onClick: () => uploadRef.current?.click() }, h(UploadIcon, { size: 15 })),
        h(IconButton, { title: t('files.refresh'), onClick: refresh }, h(RefreshIcon, { size: 15 })),
        h(IconButton, { title: t('quick.title'), onClick: () => setQuickOpen(true) }, h(SearchIcon, { size: 15 })))),

    h('div', { className: 'ra-crumbs', title: root },
      h(FolderIcon, { size: 13 }),
      h('span', { className: 'ra-crumb-muted' }, workspace.hostName || ''),
      h('span', { className: 'ra-crumb-sep' }, ':'),
      h('span', { className: 'ra-crumb-path' }, root)),
    h('input', { ref: uploadRef, type: 'file', style: { display: 'none' }, onChange: upload }),
    openFile
      ? h(FileView, {
        file: openFile,
        hostId,
        rpc,
        notify,
        onClose: () => { setOpenFile(null); refreshAll(); },
        onSaveState: (next) => setOpenFile((prev) => (prev && prev.path === next.path ? { ...prev, ...next } : prev)),
        workspaceRoot: root,
        onRevealInTerminal,
        copy,
      })
      : h('div', {
        className: 'ra-tree',
        onContextMenu: (event) => openMenu(event, null, root),
        onMouseDown: (event) => { if (event.button === 0) setMenu(null); },
      },
      rootNode && rootNode.loading && !rootNode.entries
        ? h('div', { className: 'ra-tree-note' }, t('files.loading'))
        : rootNode && rootNode.error
          ? h('div', { className: 'ra-tree-note is-error' }, rootNode.error)
          : rootEntries && rootEntries.length === 0
            ? h('div', { className: 'ra-tree-note' }, t('files.emptyDir'))
            : rootEntries
              ? rootEntries.map((entry) => h('div', { key: entry.path }, renderRow(entry, 0)))
              : null,
      rootNode && rootNode.truncated ? h('div', { className: 'ra-tree-note' }, t('files.truncated')) : null),
    quickOpen ? h(QuickOpen, {
      hostId,
      workspace,
      rpc,
      onClose: () => setQuickOpen(false),
      onOpen: async (path) => {
        setQuickOpen(false);
        await openEntry({ path, name: basename(path), type: 'file', size: 0 });
      },
    }) : null,
    menu ? h(Menu, { menu, items: menuItems(menu.entry, menu.parentPath) }) : null,
    prompt ? h(PromptDialog, {
      title: prompt.kind === 'rename' ? t('prompt.rename') : prompt.kind === 'newFolder' ? t('prompt.newFolder') : t('prompt.newFile'),
      label: prompt.kind === 'rename' ? t('prompt.name') : prompt.kind === 'newFolder' ? t('prompt.newFolder') : t('prompt.newFile'),
      value: prompt.value,
      onCancel: () => setPrompt(null),
      onSubmit: (value) => {
        const current = prompt;
        setPrompt(null);
        if (!value) return;
        if (current.kind === 'rename') doRename(current.entry, value);
        else doCreate(current.parent, value, current.kind === 'newFolder' ? 'dir' : 'file');
      },
    }) : null,
    confirm ? h(Modal, {
      title: t('confirm.deleteTitle'),
      width: 460,
      onClose: () => setConfirm(null),
      footer: [
        h(Button, { key: 'c', onClick: () => setConfirm(null) }, t('dlg.cancel')),
        h(Button, { key: 'd', variant: 'danger', onClick: () => { const current = confirm; setConfirm(null); doDelete(current.entry); } }, t('dlg.delete')),
      ],
    }, h('div', { className: 'ra-confirm-text' }, t('confirm.deleteBody', { path: confirm.entry.path }))) : null,
    busy ? h('div', { className: 'ra-busy' }, busy) : null);
}

function Menu({ menu, items }) {
  return h('div', {
    className: 'ra-menu',
    style: { left: menu.x, top: menu.y },
    onMouseDown: (event) => event.stopPropagation(),
  }, items.map((item, index) => {
    if (item.type === 'sep') return h('div', { key: 'sep' + index, className: 'ra-menu-sep' });
    const Icon = item.icon;
    return h('button', {
      key: item.id,
      type: 'button',
      className: 'ra-menu-item' + (item.danger ? ' is-danger' : ''),
      disabled: item.disabled,
      onClick: () => item.run(),
    }, Icon ? h(Icon, { size: 14 }) : h('span', { className: 'ra-menu-icon-space' }), h('span', null, item.label));
  }));
}

function PromptDialog({ title, label, value, onSubmit, onCancel }) {
  const [text, setText] = React.useState(value || '');
  const submit = () => onSubmit(text.trim());
  return h(Modal, {
    title,
    width: 460,
    onClose: onCancel,
    footer: [
      h(Button, { key: 'c', onClick: onCancel }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', onClick: submit }, t('dlg.ok')),
    ],
  }, h('label', { className: 'ra-field' },
    h('span', { className: 'ra-field-label' }, label),
    h('input', {
      className: 'ra-input',
      autoFocus: true,
      value: text,
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
    })));
}

export function FileView({ file, hostId, rpc, notify, onClose, onSaveState, workspaceRoot, onRevealInTerminal, copy }) {
  const [text, setText] = React.useState(file.text || '');
  const [mtime, setMtime] = React.useState(file.mtime || 0);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [view, setView] = React.useState(() => (isMarkdown(file.name) ? 'preview' : 'editor'));
  const [error, setError] = React.useState(file.error || '');
  const textareaRef = React.useRef(null);
  const gutterRef = React.useRef(null);

  React.useEffect(() => {
    setText(file.text || '');
    setMtime(file.mtime || 0);
    setDirty(false);
    setError(file.error || '');
    setView(isMarkdown(file.name) ? 'preview' : 'editor');
  }, [file.path, file.mtime]);

  const save = React.useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const result = await rpc('fs.write', {
        hostId, path: file.path, base64: toBase64(text), expectedMtime: mtime,
      });
      if (!result.ok) throw new Error(result.message);
      setMtime(result.mtime || Date.now());
      setDirty(false);
      notify(t('files.saved'), 'success');
    } catch (err) {
      if (err.code === 'CONFLICT') setError(t('files.conflict'));
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, hostId, file.path, text, mtime, rpc, notify]);

  React.useEffect(() => {
    if (file.kind !== 'text' && file.kind !== 'markdown' && file.kind !== 'html') return undefined;
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, file.kind]);

  const dataUrl = file.base64 ? `data:${mimeOf(file.name)};base64,${file.base64}` : '';
  const canEdit = file.kind === 'text' || file.kind === 'markdown' || file.kind === 'html';
  const relative = file.path.startsWith(workspaceRoot.replace(/\/+$/, '') + '/')
    ? file.path.slice(workspaceRoot.replace(/\/+$/, '').length + 1)
    : file.path;

  let body = null;
  if (file.loading) body = h('div', { className: 'ra-file-loading' }, t('files.loading'));
  else if (error && !file.text) body = h('div', { className: 'ra-file-error' }, error);
  else if (file.tooLarge) body = h('div', { className: 'ra-file-empty' }, h('div', null, t('files.tooLarge')), h('div', { className: 'ra-muted' }, formatBytes(file.size, t)));
  else if (isImage(file.name) && dataUrl) body = h('div', { className: 'ra-image-wrap' }, h('img', { src: dataUrl, alt: file.name }));
  else if (isPdf(file.name) && dataUrl) body = h('iframe', { className: 'ra-frame', src: dataUrl, title: file.name });
  else if (isVideo(file.name) && dataUrl) body = h('video', { className: 'ra-video', src: dataUrl, controls: true });
  else if (isAudio(file.name) && dataUrl) body = h('audio', { className: 'ra-audio', src: dataUrl, controls: true });
  else if (file.kind === 'binary' || file.binary) body = h('div', { className: 'ra-file-empty' },
    h('div', null, t('files.binary')),
    h('div', { className: 'ra-muted' }, `${formatBytes(file.size, t)} · ${file.kind || 'binary'}`),
    h(Button, { variant: 'default', onClick: () => downloadBase64(file.name, file.base64, mimeOf(file.name)) }, t('files.download')));
  else if (canEdit) {
    if (view === 'preview' && (isMarkdown(file.name) || file.kind === 'markdown')) {
      body = h('div', { className: 'ra-preview-wrap' }, h(Markdown, { text }));
    } else if (view === 'preview' && isHtml(file.name)) {
      body = h('iframe', { className: 'ra-frame', sandbox: 'allow-scripts', srcDoc: text, title: file.name });
    } else {
      const lines = text.split('\n').length;
      body = h('div', { className: 'ra-editor' },
        h('div', { className: 'ra-gutter', ref: gutterRef, 'aria-hidden': true }, Array.from({ length: Math.min(lines, 20000) }, (_, index) => h('div', { key: index }, index + 1))),
        h('textarea', {
          ref: textareaRef,
          className: 'ra-code',
          value: text,
          spellCheck: false,
          wrap: 'off',
          onChange: (event) => { setText(event.target.value); setDirty(true); },
          onScroll: (event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; },
          onKeyDown: (event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              const target = event.currentTarget;
              const start = target.selectionStart;
              const next = text.slice(0, start) + '  ' + text.slice(target.selectionEnd);
              setText(next);
              setDirty(true);
              requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; });
            }
          },
        }));
    }
  } else {
    body = h('div', { className: 'ra-file-empty' }, h('div', null, t('files.binary')), h(Button, {
      variant: 'default',
      onClick: () => { if (file.base64) downloadBase64(file.name, file.base64, mimeOf(file.name)); },
    }, t('files.download')));
  }

  return h('div', { className: 'ra-fileview' },
    h('div', { className: 'ra-fileview-head' },
      h(IconButton, { title: t('misc.back'), onClick: onClose }, h(BackIcon, { size: 16 })),
      h('div', { className: 'ra-fileview-title' },
        h('div', { className: 'ra-fileview-name', title: file.path }, file.name, dirty ? h('span', { className: 'ra-dirty' }, '•') : null),
        h('div', { className: 'ra-fileview-sub' }, relative)),
      h('div', { className: 'ra-head-actions' },
        canEdit && (isMarkdown(file.name) ? h(IconButton, {
          title: view === 'preview' ? t('files.viewEditor') : t('files.viewPreview'),
          active: view === 'preview',
          onClick: () => setView(view === 'preview' ? 'editor' : 'preview'),
        }, view === 'preview' ? h(EditIcon, { size: 15 }) : h(EyeIcon, { size: 15 })) : null),
        canEdit ? h(IconButton, { title: t('files.save'), onClick: save, disabled: !dirty || saving }, saving ? h('span', { className: 'ra-spin-sm' }) : h(SaveIcon, { size: 15 })) : null,
        isImage(file.name) && dataUrl ? h(IconButton, { title: t('files.download'), onClick: () => downloadBase64(file.name, file.base64, mimeOf(file.name)) }, h(DownloadIcon, { size: 15 })) : null,
        h(IconButton, { title: t('files.copyPath'), onClick: () => copy(file.path) }, h(CopyIcon, { size: 15 })),
        onRevealInTerminal ? h(IconButton, { title: t('files.openInTerminal'), onClick: () => onRevealInTerminal(dirname(file.path)) }, h(CodeIcon, { size: 15 })) : null)),
    error ? h('div', { className: 'ra-file-banner is-error' }, error) : null,
    dirty ? h('div', { className: 'ra-file-banner' }, t('files.unsaved')) : null,
    h('div', { className: 'ra-fileview-body' }, body));
}


function QuickOpen({ hostId, workspace, rpc, onClose, onOpen }) {
  const [query, setQuery] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const text = query.trim();
    if (!text) { setItems([]); setError(''); return undefined; }
    const timer = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const result = await rpc('fs.search', { hostId, path: workspace.path, query: text, limit: 200 });
        setItems(result.results || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [query, hostId, workspace.path, rpc]);

  const choose = (item) => onOpen(item.path);

  return h(Modal, {
    title: t('quick.title'),
    subtitle: t('quick.hint'),
    width: 640,
    onClose,
  },
  h('div', { className: 'ra-quick' },
    h('input', {
      className: 'ra-input ra-quick-input',
      autoFocus: true,
      value: query,
      placeholder: t('quick.placeholder'),
      onChange: (event) => setQuery(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter' && items[0]) choose(items[0]);
        if (event.key === 'Escape') onClose();
      },
    }),
    h('div', { className: 'ra-quick-list' },
      busy ? h('div', { className: 'ra-quick-note' }, t('quick.searching'))
        : error ? h('div', { className: 'ra-quick-note is-error' }, error)
          : !query.trim() ? h('div', { className: 'ra-quick-note' }, t('quick.hint'))
            : items.length === 0 ? h('div', { className: 'ra-quick-note' }, t('quick.empty'))
              : items.map((item) => h('button', {
                key: item.path,
                type: 'button',
                className: 'ra-quick-row',
                onClick: () => choose(item),
              }, h(FileIcon, { size: 15 }), h('span', { className: 'ra-quick-name' }, item.name), h('span', { className: 'ra-quick-path' }, item.relative))))));
}
