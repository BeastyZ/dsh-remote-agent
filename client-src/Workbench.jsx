import { React, h, t, setLocale } from './runtime.js';
import { workspaceSessions, chooseSession } from './workspace-selection.js';
import { rpc } from './api.js';
import {
  BranchIcon, Dot, EditIcon, FolderIcon, LinkIcon, PlayIcon, PlusIcon, RefreshIcon, ServerIcon,
  SettingsIcon, Spinner, TerminalIcon,
} from './icons.jsx';
import { Button, IconButton, Toast, copyText } from './ui.jsx';
import { TerminalView } from './TerminalView.jsx';
import { FilesPanel } from './FilesPanel.jsx';
import { GitPanel } from './GitPanel.jsx';
import {
  AddHostModal, CustomAgentModal, PasswordModal, PortsModal, RenameSessionModal, SettingsModal,
  WorkspacePickerModal,
} from './Modals.jsx';

function shellQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}

function StatusBadge({ status, onClick, tr = t }) {
  const state = status?.state || 'unknown';
  const label = state === 'online' ? tr('status.connected')
    : state === 'connecting' ? tr('status.connecting')
      : state === 'error' ? tr('status.error')
        : tr('status.disconnected');
  return h('button', {
    type: 'button',
    className: 'ra-status ' + state,
    onClick,
    title: status?.error || label,
  }, h(Dot, { state: state === 'online' ? 'online' : state === 'error' ? 'offline' : state === 'connecting' ? 'connecting' : 'idle' }),
  h('span', null, label),
  state === 'online' && status?.latencyMs ? h('span', { className: 'ra-status-lat' }, `${status.latencyMs} ms`) : null);
}

export function Workbench({ ctx }) {
  const [boot, setBoot] = React.useState(null);
  const [hosts, setHosts] = React.useState([]);
  const [workspaces, setWorkspaces] = React.useState([]);
  const [terminals, setTerminals] = React.useState([]);
  const [hostId, setHostId] = React.useState(null);
  const [wsId, setWsId] = React.useState(null);
  const [statuses, setStatuses] = React.useState({});
  const [harness, setHarness] = React.useState({ loading: false, list: [], tools: null, env: null, error: '', at: 0 });
  const [activeTerm, setActiveTerm] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [modal, setModal] = React.useState(null);
  const [rightWidth, setRightWidth] = React.useState(360);
  const [rightTab, setRightTab] = React.useState('files');
  const [gitInfo, setGitInfo] = React.useState(null);
  const [gitLoading, setGitLoading] = React.useState(false);
  const [forwards, setForwards] = React.useState([]);
  const [portsOpen, setPortsOpen] = React.useState(false);
  const [detectedPorts, setDetectedPorts] = React.useState({});
  const [renameSession, setRenameSession] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [configPath, setConfigPath] = React.useState('');
  const [warnings, setWarnings] = React.useState([]);
  const [, forceLocale] = React.useState(0);
  const connecting = React.useRef(new Set());
  const hostRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const terminalsRef = React.useRef([]);
  const workspacesRef = React.useRef([]);
  const activeByWorkspace = React.useRef(new Map());
  const openTerminal = React.useCallback((terminalId) => {
    if (wsRef.current) activeByWorkspace.current.set(wsRef.current, terminalId);
    setActiveTerm(terminalId);
    rpc('ws.selectTerminal', { workspaceId: wsRef.current, terminalId }).catch(() => {});
  }, []);

  const notify = React.useCallback((message, kind = 'info') => {
    setToast({ message, kind, id: Date.now() });
  }, []);

  React.useEffect(() => {
    const apply = () => {
      const snapshot = ctx.locale.getSnapshot();
      setLocale(snapshot.active);
      forceLocale((value) => value + 1);
    };
    apply();
    return ctx.locale.subscribe(apply);
  }, [ctx]);

  React.useEffect(() => {
    hostRef.current = hostId;
    wsRef.current = wsId;
    workspacesRef.current = workspaces;
  }, [hostId, wsId, terminals, workspaces]);

  const host = hosts.find((item) => item.id === hostId) || null;
  const workspace = workspaces.find((item) => item.id === wsId) || null;
  const hostWorkspaces = workspaces.filter((item) => item.hostId === hostId);
  const hostTerminals = workspaceSessions(terminals, workspace);
  const active = hostTerminals.find((item) => item.id === activeTerm) || null;

  const refreshTerminals = React.useCallback(async () => {
    try {
      const result = await rpc('term.list');
      const list = result.terminals || [];
      setTerminals(list);
      const selected = workspacesRef.current.find(item => item.id === wsRef.current) || null;
      const previous = activeByWorkspace.current.get(wsRef.current);
      setActiveTerm((current) => chooseSession(current, previous, workspaceSessions(list, selected)));
    } catch { /* keep the last known list */ }
  }, []);

  const connectHost = React.useCallback(async (id, { force = false } = {}) => {
    if (!id || connecting.current.has(id)) return;
    connecting.current.add(id);
    setStatuses((prev) => ({ ...prev, [id]: { state: 'connecting', error: '' } }));
    try {
      const result = await rpc('host.test', { hostId: id, force });
      setStatuses((prev) => ({ ...prev, [id]: { state: 'online', latencyMs: result.latencyMs, reused: result.reused, error: '' } }));
    } catch (error) {
      setStatuses((prev) => ({ ...prev, [id]: { state: 'error', error: error.message, code: error.code } }));
      if (error.code === 'AUTH') setModal({ kind: 'password', hostId: id });
    } finally {
      connecting.current.delete(id);
    }
  }, []);

  const refreshHarness = React.useCallback(async (id = hostRef.current, workspaceId = wsRef.current, force = false) => {
    if (!id || !workspaceId) return;
    setHarness((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const result = await rpc('harness.list', { hostId: id, force });
      setHarness({ loading: false, list: result.harnesses || [], tools: result.tools || null, env: result.env || null, error: '', at: result.at || Date.now(), cached: result.cached });
    } catch (error) {
      setHarness((prev) => ({ ...prev, loading: false, error: error.message }));
      if (error.code === 'AUTH') setModal({ kind: 'password', hostId: id });
    }
  }, []);

  const refreshGit = React.useCallback(async () => {
    if (!workspace) { setGitInfo(null); return null; }
    setGitLoading(true);
    try {
      const info = await rpc('git.info', { hostId: workspace.hostId, path: workspace.path });
      setGitInfo(info);
      if (!info.isRepo) setRightTab((current) => (current === 'git' ? 'files' : current));
      return info;
    } catch (error) {
      setGitInfo({ isRepo: false, error: error.message, entries: [] });
      return null;
    } finally {
      setGitLoading(false);
    }
  }, [workspace?.hostId, workspace?.path]);

  const refreshForwards = React.useCallback(async () => {
    try {
      const result = await rpc('forward.list', {});
      setForwards(result.forwards || []);
    } catch { /* the host may be restarting */ }
  }, []);

  React.useEffect(() => {
    setRightTab('files');
    setGitInfo(null);
    if (workspace) refreshGit();
  }, [workspace?.id]);

  React.useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyG') {
        event.preventDefault();
        setRightTab((current) => (gitInfo?.isRepo ? (current === 'git' ? 'files' : 'git') : current));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gitInfo?.isRepo]);

  React.useEffect(() => {
    refreshForwards();
  }, [hostId, refreshForwards]);

  React.useEffect(() => {
    if (rightTab !== 'git' || !workspace) return undefined;
    const timer = setInterval(refreshGit, 15000);
    return () => clearInterval(timer);
  }, [rightTab, workspace?.id, refreshGit]);

  const noteTerminalOutput = React.useCallback((sessionId, text) => {
    const clean = String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const regex = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi;
    const found = [];
    let match;
    while ((match = regex.exec(clean))) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) found.push(port);
    }
    if (!found.length) return;
    setDetectedPorts((prev) => {
      const current = prev[sessionId] || [];
      const next = [...current];
      for (const port of found) if (!next.includes(port)) next.push(port);
      if (next.length === current.length) return prev;
      return { ...prev, [sessionId]: next.slice(0, 8) };
    });
  }, []);

  const openForward = (forward) => {
    if (!forward) return;
    let win = null;
    try { win = window.open(forward.url, '_blank'); } catch { win = null; }
    if (win) {
      try { win.opener = null; } catch { /* cross-origin window */ }
      return;
    }
    // Popup blocked: keep the URL recoverable instead of failing silently.
    copyText(forward.url).then((ok) => notify(ok ? forward.url : t('toast.copyFailed'), ok ? 'success' : 'error'));
  };

  const addForward = async (params) => {
    const result = await rpc('forward.add', params);
    setForwards((prev) => [...prev.filter((item) => item.id !== result.forward.id), result.forward]);
    notify(t('ports.added') + ': ' + result.forward.url, 'success');
    return result.forward;
  };

  const removeForward = async (forward) => {
    try {
      await rpc('forward.remove', { id: forward.id });
      setForwards((prev) => prev.filter((item) => item.id !== forward.id));
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const openPort = async (port) => {
    if (!workspace) return;
    const existing = forwards.find((forward) => forward.hostId === workspace.hostId && forward.remotePort === Number(port));
    if (existing) { openForward(existing); return; }
    try {
      const result = await rpc('forward.add', {
        hostId: workspace.hostId,
        remotePort: Number(port),
        localPort: Number(port),
      });
      setForwards((prev) => [...prev.filter((item) => item.id !== result.forward.id), result.forward]);
      openForward(result.forward);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const adoptWorkspace = (ws) => {
    if (!ws) return;
    setWorkspaces((prev) => [...prev.filter((item) => item.id !== ws.id), ws]);
    const next = workspaceSessions(terminals, ws);
    setActiveTerm(chooseSession(activeByWorkspace.current.get(ws.id), null, next));
    setWsId(ws.id);
    rpc('ws.select', { hostId: ws.hostId, workspaceId: ws.id }).catch(() => {});
    connectHost(ws.hostId);
    setTimeout(() => refreshHarness(ws.hostId, ws.id, true), 150);
  };

  const dropWorkspace = (id) => {
    setWorkspaces((prev) => prev.filter((item) => item.id !== id));
    if (wsId === id) setWsId(null);
  };

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await rpc('bootstrap');
        if (cancelled) return;
        setBoot(data);
        activeByWorkspace.current = new Map(Object.entries(data.activeTerminals || {}));
        setHosts(data.hosts || []);
        setWorkspaces(data.workspaces || []);
        setTerminals(data.terminals || []);
        setSettings(data.settings || null);
        setConfigPath(data.configPath || '');
        setWarnings(data.warnings || []);
        const firstHost = data.lastHostId || data.hosts?.[0]?.id || null;
        setHostId(firstHost);
        const firstWs = data.lastWorkspaceId && data.workspaces?.some((item) => item.id === data.lastWorkspaceId)
          ? data.lastWorkspaceId
          : (data.workspaces || []).find((item) => item.hostId === firstHost)?.id || null;
        setWsId(firstWs);
        const selectedWorkspace = (data.workspaces || []).find(item => item.id === firstWs);
        const bootTerminals = workspaceSessions(data.terminals || [], selectedWorkspace);
        setActiveTerm(chooseSession(activeByWorkspace.current.get(firstWs), null, bootTerminals));
        if (firstHost) connectHost(firstHost);
        if (firstHost && firstWs) setTimeout(() => refreshHarness(firstHost, firstWs), 250);
      } catch (error) {
        notify(error.message, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, []);
  React.useEffect(() => {
    if (!boot) return;
    const visible = workspaceSessions(terminals, workspace);
    const previous = activeByWorkspace.current.get(wsId);
    setActiveTerm((current) => chooseSession(current, previous, visible));
  }, [wsId, hostId, boot]);

  const selectHost = (id) => {
    if (id === hostId) return;
    setHostId(id);
    const next = workspaces.find((item) => item.hostId === id);
    const previous = activeByWorkspace.current.get(next?.id);
    setActiveTerm(previous || null);
    setWsId(next ? next.id : null);
    rpc('ws.select', { hostId: id, workspaceId: next ? next.id : null }).catch(() => {});
    connectHost(id);
    if (next) setTimeout(() => refreshHarness(id, next.id), 150);
  };

  const selectWorkspace = (id) => {
    const previous = activeByWorkspace.current.get(id);
    const ws = workspaces.find((item) => item.id === id);
    const visible = workspaceSessions(terminals, ws);
    setActiveTerm(chooseSession(previous, null, visible));
    setWsId(id);
    rpc('ws.select', { hostId: ws?.hostId || hostId, workspaceId: id }).catch(() => {});
    if (ws && ws.hostId !== hostId) setHostId(ws.hostId);
    if (ws) {
      connectHost(ws.hostId);
      setTimeout(() => refreshHarness(ws.hostId, id), 150);
    }
  };

  const launch = async (item, command) => {
    if (!workspace) { notify(t('welcome.pickWs'), 'error'); return; }
    if (!command && !item) { command = ''; }
    const launchedWorkspace = wsId;
    const title = (item ? item.name : t('sessions.terminal')) + ' · ' + workspace.name;
    try {
      const result = await rpc('term.create', {
        hostId: workspace.hostId,
        cwd: workspace.path,
        workspaceId: workspace.id,
        command: command || '',
        title,
        cols: 110,
        rows: 28,
      });
      const session = result.session;
      setTerminals((prev) => [...prev.filter(entry => entry.id !== session.id), session]);
      if (wsRef.current === launchedWorkspace) openTerminal(session.id);
    } catch (error) {
      if (error.code === 'AUTH') setModal({ kind: 'password', hostId: workspace.hostId });
      notify(error.message, 'error');
    }
  };

  const resumeTerminal = async (session, restart = false) => {
    try {
      const result = await rpc('term.resume', { id: session.id, restart });
      setTerminals((prev) => prev.map((item) => item.id === session.id ? { ...result.session } : item));
      openTerminal(session.id);
    } catch (error) {
      notify(error.message, 'error');
      if (error.code === 'AUTH') setModal({ kind: 'password', hostId: session.hostId });
    }
  };

  // Auto-attach saved tmux sessions once per panel visit after SSH is ready.
  // Each effect owns a queue; successful reconnects change the candidates and
  // start the next queue without ever relaunching an absent remote process.
  const autoReconnectAttempts = React.useRef(new Set());
  const reconnectCandidates = hostTerminals
    .filter((item) => item.persistent && item.state === 'detached')
    .map((item) => item.id).join(',');
  const hostOnline = statuses[hostId]?.state === 'online';
  React.useEffect(() => {
    if (!hostOnline || !reconnectCandidates) return undefined;
    let cancelled = false;
    (async () => {
      for (const id of reconnectCandidates.split(',')) {
        if (cancelled) break;
        if (autoReconnectAttempts.current.has(id)) continue;
        autoReconnectAttempts.current.add(id);
        try {
          const result = await rpc('term.resume', { id, restart: false });
          // Apply an in-flight success even if the selected host changed. Its
          // record still belongs to that host; keep the user's selected tab.
          setTerminals((prev) => prev.map((item) => item.id === id ? result.session : item));
        } catch (error) {
          if (cancelled) break;
          // Keep the detached record so the manual retry button stays.
          setTerminals((prev) => prev.map((item) => item.id === id
            ? { ...item, autoReconnectError: error.message } : item));
          if (error.code === 'AUTH') {
            autoReconnectAttempts.current.delete(id);
            setModal({ kind: 'password', hostId });
            break;
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [hostId, hostOnline, reconnectCandidates, notify]);

  const closeTerminal = async (id) => {
    if (!window.confirm(t('confirm.closeSession'))) return;
    try {
      await rpc('term.close', { id });
      setTerminals((prev) => prev.filter((item) => item.id !== id));
      const deleted = terminals.find(item => item.id === id);
      activeByWorkspace.current.delete(deleted?.workspaceId || workspace?.id);
      rpc('ws.selectTerminal', { workspaceId: deleted?.workspaceId || workspace?.id, terminalId: null }).catch(() => {});
      setActiveTerm((current) => (current === id ? null : current));
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const submitRename = async (title) => {
    const target = renameSession;
    setRenameSession(null);
    if (!target) return;
    try {
      const result = await rpc('term.rename', { id: target.id, title });
      setTerminals((prev) => prev.map((item) => (item.id === target.id ? { ...item, title: result.session.title } : item)));
      notify(t('sessions.renamed'), 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const addWorkspace = async (pathValue) => {
    try {
      const result = await rpc('ws.add', { hostId, path: pathValue });
      const ws = result.workspace;
      setWorkspaces((prev) => [...prev.filter((item) => item.id !== ws.id), ws]);
      setActiveTerm(chooseSession(activeByWorkspace.current.get(ws.id), null, workspaceSessions(terminals, ws)));
      setWsId(ws.id);
      setModal(null);
      connectHost(ws.hostId);
      setTimeout(() => refreshHarness(ws.hostId, ws.id, true), 150);
      notify(t('toast.created') + ': ' + ws.name, 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const removeWorkspace = async (id) => {
    try {
      await rpc('ws.remove', { id });
      setWorkspaces((prev) => prev.filter((item) => item.id !== id));
      if (wsId === id) {
        activeByWorkspace.current.delete(id);
        setWsId(null);
        setActiveTerm(null);
      }
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const reloadHosts = async () => {
    try {
      const result = await rpc('hosts.refresh', {});
      setHosts(result.hosts || []);
      if (!result.hosts?.some((item) => item.id === hostId)) setHostId(result.hosts?.[0]?.id || null);
      notify(t('files.refresh'), 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const saveSettings = async (next) => {
    try {
      const result = await rpc('settings.set', { settings: next });
      setSettings(result.settings);
      setModal(null);
      notify(t('settings.saved'), 'success');
      reloadHosts();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const startResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const move = (moveEvent) => {
      const next = Math.max(280, Math.min(760, startWidth + (startX - moveEvent.clientX)));
      setRightWidth(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const renderHostRow = (item) => {
    const status = statuses[item.id] || { state: 'unknown' };
    const selected = item.id === hostId;
    return h('button', {
      key: item.id,
      type: 'button',
      className: 'ra-host-row' + (selected ? ' is-selected' : ''),
      onClick: () => selectHost(item.id),
      title: item.detail,
    },
      h(ServerIcon, { size: 15 }),
      h('span', { className: 'ra-host-main' },
        h('span', { className: 'ra-host-name' }, item.name),
        h('span', { className: 'ra-host-detail' }, item.detail || item.hostName)),
      h(Dot, { state: status.state === 'online' ? 'online' : status.state === 'connecting' ? 'connecting' : status.state === 'error' ? 'offline' : 'idle' }));
  };

  const renderWorkspaceRow = (item) => {
    const selected = item.id === wsId;
    return h('button', {
      key: item.id,
      type: 'button',
      className: 'ra-ws-row' + (selected ? ' is-selected' : ''),
      onClick: () => selectWorkspace(item.id),
      onContextMenu: (event) => { event.preventDefault(); if (window.confirm(t('ws.remove') + ': ' + item.name + '?')) removeWorkspace(item.id); },
      title: item.path,
    },
      h(FolderIcon, { size: 14 }),
      h('span', { className: 'ra-ws-main' },
        h('span', { className: 'ra-ws-name' }, item.name),
        h('span', { className: 'ra-ws-path' }, item.path)));
  };

  const renderHarnessRow = (item) => h('div', { key: item.id, className: 'ra-agent-row' },
    h('div', { className: 'ra-agent-icon' }, h(TerminalIcon, { size: 15 })),
    h('div', { className: 'ra-agent-main' },
      h('div', { className: 'ra-agent-name' }, item.name),
      h('div', { className: 'ra-agent-meta', title: item.path }, item.version || item.path)),
    h(IconButton, { title: t('agent.launch'), onClick: () => launch(item) }, h(PlayIcon, { size: 13 })));

  const renderTerminalRow = (item) => h('div', {
    key: item.id,
    className: 'ra-session-row' + (item.id === activeTerm ? ' is-selected' : ''),
    onClick: () => openTerminal(item.id),
    onDoubleClick: () => setRenameSession(item),
    title: t('sessions.renameHint'),
  },
  h('span', { className: 'ra-session-dot ' + (item.state === 'running' ? 'is-live' : '') }),
  h('span', { className: 'ra-session-name', title: item.title }, item.title),
  h('button', {
    type: 'button',
    className: 'ra-session-edit',
    title: t('sessions.rename'),
    onClick: (event) => { event.stopPropagation(); setRenameSession(item); },
  }, h(EditIcon, { size: 12 })),
  h('button', {
    type: 'button',
    className: 'ra-session-close',
    title: t('sessions.close'),
    onClick: (event) => { event.stopPropagation(); closeTerminal(item.id); },
  }, '×'));

  let welcome = null;
  if (!host) {
    welcome = h('div', { className: 'ra-welcome' },
      h('div', { className: 'ra-welcome-mark' }, h(ServerIcon, { size: 34 })),
      h('h1', null, t('welcome.title')),
      h('p', null, t('welcome.sub')),
      h('div', { className: 'ra-steps' },
        h('div', { className: 'ra-step' },
          h('span', null, '1'),
          h('div', null,
            h('strong', null, t('welcome.step1')),
            h('p', null, hosts.length ? t('welcome.pickHost') : t('conn.empty')))),
        h('div', { className: 'ra-step' },
          h('span', null, '2'),
          h('div', null,
            h('strong', null, t('welcome.step2')),
            h('p', null, t('ws.empty')))),
        h('div', { className: 'ra-step' },
          h('span', null, '3'),
          h('div', null,
            h('strong', null, t('welcome.step3')),
            h('p', null, t('welcome.terminalHint'))))),
      h('div', { className: 'ra-welcome-actions' },
        h(Button, { variant: 'primary', onClick: () => setModal({ kind: 'addHost' }) }, t('conn.add')),
        h(Button, { onClick: reloadHosts }, t('conn.refresh'))));
  } else if (!workspace) {
    welcome = h('div', { className: 'ra-welcome' },
      h('div', { className: 'ra-welcome-mark' }, h(FolderIcon, { size: 34 })),
      h('h1', null, t('ws.pick')),
      h('p', null, `${host.name} · ${host.detail}`),
      h('div', { className: 'ra-welcome-actions' },
        h(Button, { variant: 'primary', onClick: () => setModal({ kind: 'picker', hostId }) }, t('ws.open')),
        h(Button, { onClick: () => connectHost(hostId, { force: true }) }, t('status.retry'))));
  } else {
    const cards = harness.list.length
      ? h('div', { className: 'ra-agent-grid' }, harness.list.map((item) => h('button', {
        key: item.id,
        type: 'button',
        className: 'ra-agent-card',
        onClick: () => launch(item),
        title: item.path,
      },
      h('div', { className: 'ra-agent-card-icon' }, h(TerminalIcon, { size: 20 })),
      h('div', { className: 'ra-agent-card-name' }, item.name),
      h('div', { className: 'ra-agent-card-meta' }, item.vendor || t('agent.installed')),
      h('div', { className: 'ra-agent-card-path' }, item.version || item.path.split('/').pop()))))
      : h('div', { className: 'ra-empty-card' },
        h('div', null, harness.loading ? h(Spinner, { size: 16 }) : t('agent.empty')),
        h('div', { className: 'ra-welcome-actions' },
          h(Button, { onClick: () => setModal({ kind: 'custom', hostId, workspaceId: workspace.id }) }, t('agent.custom')),
          h(Button, { onClick: () => launch(null, '') }, t('sessions.new'))));

    welcome = h('div', { className: 'ra-welcome ra-welcome-ws' },
      h('div', { className: 'ra-welcome-head' },
        h('div', null,
          h('div', { className: 'ra-eyebrow' }, `${host.name} · ${host.detail}`),
          h('h1', null, workspace.name),
          h('div', { className: 'ra-welcome-path' }, workspace.path)),
        h(StatusBadge, { status: statuses[hostId] || {}, onClick: () => connectHost(hostId, { force: true }) })),
      harness.error ? h('div', { className: 'ra-banner is-error' }, harness.error) : null,
      h('div', { className: 'ra-welcome-section-head' },
        h('div', null,
          h('strong', null, t('agent.title')),
          h('span', { className: 'ra-muted' }, harness.loading
            ? ' · ' + t('misc.loading')
            : harness.env
              ? ` · ${harness.env.os || ''} ${harness.env.arch || ''} · ${harness.env.shell || ''}`
              : '')),
        h('div', { className: 'ra-head-actions' },
          h(IconButton, { title: t('agent.scan'), onClick: () => refreshHarness(hostId, workspace.id, true) }, h(RefreshIcon, { size: 15 })),
          h(IconButton, { title: t('sessions.new'), onClick: () => launch(null, '') }, h(TerminalIcon, { size: 15 })))),
      cards,
      h('div', { className: 'ra-welcome-actions' },
        h(Button, { onClick: () => setModal({ kind: 'custom', hostId, workspaceId: workspace.id }) }, t('agent.custom')),
        h(Button, { onClick: () => launch(null, '') }, t('welcome.terminalHint'))),
      !harness.list.length && !harness.loading
        ? h('div', { className: 'ra-agent-supported' }, 'Codex · Kimi · Claude Code · Gemini · OpenCode · Aider · Qwen · Crush · Goose · Amp · Droid · Cursor Agent · Copilot · DSH')
        : null);
  }

  return h('div', { className: 'ra-root' },
    h('aside', { className: 'ra-left' },
      h('div', { className: 'ra-left-head' },
        h('div', { className: 'ra-brand' },
          h('span', { className: 'ra-brand-mark' }, h(ServerIcon, { size: 17 })),
          h('div', null,
            h('div', { className: 'ra-brand-title' }, t('panel.title')),
            h('div', { className: 'ra-brand-sub' }, t('panel.hint')))),
        h(IconButton, { title: t('settings.title'), onClick: () => setModal({ kind: 'settings' }) }, h(SettingsIcon, { size: 16 }))),
      h('div', { className: 'ra-left-scroll' },
        h('div', { className: 'ra-section' },
          h('div', { className: 'ra-section-head' },
            h('span', null, t('conn.title')),
            h('span', { className: 'ra-head-actions' },
              h(IconButton, { title: t('conn.refresh'), onClick: reloadHosts }, h(RefreshIcon, { size: 13 })),
              h(IconButton, { title: t('conn.add'), onClick: () => setModal({ kind: 'addHost' }) }, h(PlusIcon, { size: 13 })))),
          hosts.length ? hosts.map(renderHostRow) : h('div', { className: 'ra-hint' }, t('conn.empty'))),
        hosts.length ? h('div', { className: 'ra-section' },
          h('div', { className: 'ra-section-head' },
            h('span', null, t('ws.title')),
            h('span', { className: 'ra-head-actions' },
              h(IconButton, { title: t('ws.open'), onClick: () => hostId && setModal({ kind: 'picker', hostId }) }, h(PlusIcon, { size: 13 })))),
          hostWorkspaces.length ? hostWorkspaces.map(renderWorkspaceRow) : h('div', { className: 'ra-hint' }, t('ws.empty'))) : null,
        workspace ? h('div', { className: 'ra-section' },
          h('div', { className: 'ra-section-head' },
            h('span', null, t('agent.title')),
            h('span', { className: 'ra-head-actions' },
              h(IconButton, { title: t('agent.scan'), onClick: () => refreshHarness(hostId, workspace.id, true) }, h(RefreshIcon, { size: 13 })),
              h(IconButton, { title: t('agent.custom'), onClick: () => setModal({ kind: 'custom', hostId, workspaceId: workspace.id }) }, h(PlusIcon, { size: 13 })))),
          harness.list.length ? harness.list.map(renderHarnessRow) : h('div', { className: 'ra-hint' }, harness.loading ? t('misc.loading') : t('agent.empty'))) : null,
        h('div', { className: 'ra-section' },
          h('div', { className: 'ra-section-head' },
            h('span', null, t('sessions.title')),
            h('span', { className: 'ra-head-actions' },
              h(IconButton, { title: t('sessions.new'), onClick: () => workspace && launch(null, ''), disabled: !workspace }, h(PlusIcon, { size: 13 })))),
          hostTerminals.length ? hostTerminals.map(renderTerminalRow) : h('div', { className: 'ra-hint' }, t('sessions.empty')))),
      h('div', { className: 'ra-left-foot' },
        h('div', { className: 'ra-foot-line', title: configPath }, h('span', null, t('conn.config')), h('span', { className: 'ra-foot-path' }, configPath || '~/.ssh/config')),
        h('div', { className: 'ra-foot-line' }, h('span', null, 'v' + (boot?.version || '0.1.0')), warnings.length ? h('span', { className: 'ra-warn', title: warnings.join('\n') }, `${warnings.length} warning`) : null))),
    h('main', { className: 'ra-center' },
      h('div', { className: 'ra-center-head' },
        h('div', { className: 'ra-center-title' },
          workspace ? h('span', { className: 'ra-center-host' }, host?.name, h('span', { className: 'ra-center-sep' }, ' / '), workspace.name) : t('panel.title'),
          workspace ? h('span', { className: 'ra-center-path' }, workspace.path) : null),
        h('div', { className: 'ra-head-actions' },
          host ? h(StatusBadge, { status: statuses[hostId] || {}, onClick: () => connectHost(hostId, { force: true }) }) : null,
          h(IconButton, { title: t('ports.title'), onClick: () => { refreshForwards(); setPortsOpen(true); } }, h(LinkIcon, { size: 15 })),
          workspace ? h(IconButton, { title: t('sessions.new'), onClick: () => launch(null, '') }, h(TerminalIcon, { size: 15 })) : null,
          workspace ? h(IconButton, { title: t('agent.scan'), onClick: () => refreshHarness(hostId, workspace.id, true) }, h(RefreshIcon, { size: 15 })) : null)),
      hostTerminals.length ? h('div', { className: 'ra-tabs' }, hostTerminals.map((item) => h('div', {
        key: item.id,
        className: 'ra-tab' + (item.id === activeTerm ? ' is-active' : ''),
        onClick: () => openTerminal(item.id),
        onDoubleClick: () => setRenameSession(item),
        title: item.title + ' · ' + t('sessions.renameHint'),
      },
      h('span', { className: 'ra-tab-dot ' + (item.state === 'running' ? 'is-live' : '') }),
      h('span', { className: 'ra-tab-title' }, item.title),
      h('button', {
        type: 'button',
        className: 'ra-tab-close',
        onClick: (event) => { event.stopPropagation(); closeTerminal(item.id); },
        title: t('sessions.close'),
      }, '×')))) : null,
      active && (detectedPorts[active.id] || []).length
        ? h('div', { className: 'ra-detected' },
          h('span', { className: 'ra-detected-label' }, t('ports.detected')),
          (detectedPorts[active.id] || []).map((port) => h('button', {
            key: port,
            type: 'button',
            className: 'ra-port-chip',
            title: t('ports.openHint', { url: `http://127.0.0.1:${port}` }),
            onClick: () => openPort(port),
          }, h(LinkIcon, { size: 11 }), ':' + port)))
        : null,
      h('div', { className: 'ra-stage' },
        active
          ? h(TerminalView, {
            key: `${active.id}:${active.generation || 0}:${active.state === 'running' ? 'live' : 'history'}`,
            session: active,
            rpc,
            active: true,
            onOutput: noteTerminalOutput,
            onExited: refreshTerminals,
            onReconnect: (session) => resumeTerminal(session, false),
            onRestart: (session) => resumeTerminal(session, true),
          })
          : welcome)),
    workspace ? h('div', { className: 'ra-resizer', onMouseDown: startResize, title: 'resize' }) : null,
    workspace ? h('aside', { className: 'ra-right', style: { width: rightWidth } },
      h('div', { className: 'ra-right-tabs' },
        h('button', {
          type: 'button',
          className: 'ra-right-tab' + (rightTab === 'files' ? ' is-active' : ''),
          onClick: () => setRightTab('files'),
        }, h(FolderIcon, { size: 13 }), t('files.title')),
        gitInfo?.isRepo ? h('button', {
          type: 'button',
          className: 'ra-right-tab' + (rightTab === 'git' ? ' is-active' : ''),
          onClick: () => { setRightTab('git'); refreshGit(); },
        }, h(BranchIcon, { size: 13 }), t('git.title'),
        gitInfo.entries?.length ? h('span', { className: 'ra-count' }, gitInfo.entries.length) : null) : null),
      h('div', { className: 'ra-right-body', style: { display: rightTab === 'files' ? 'flex' : 'none' } },
        h(FilesPanel, {
          hostId: workspace.hostId,
          workspace,
          rpc,
          notify,
          onRevealInTerminal: (path) => {
            launch(null, `cd ${shellQuote(path)} && exec "$SHELL" -l`);
          },
        })),
      gitInfo?.isRepo ? h('div', { className: 'ra-right-body', style: { display: rightTab === 'git' ? 'flex' : 'none' } },
        h(GitPanel, {
          hostId: workspace.hostId,
          workspace,
          info: gitInfo,
          loading: gitLoading,
          rpc,
          notify,
          onRefresh: refreshGit,
          onWorkspaceAdded: adoptWorkspace,
          onWorkspaceRemoved: dropWorkspace,
        })) : null) : null,
    h(Toast, { toast, onClose: () => setToast(null) }),
    modal && modal.kind === 'settings' ? h(SettingsModal, {
      settings, configPath, hosts, stateDir: boot?.settings?.stateDir || '',
      onClose: () => setModal(null), onSave: saveSettings,
      onRemoveManual: async (id) => {
        try { await rpc('hosts.removeManual', { id }); reloadHosts(); } catch (error) { notify(error.message, 'error'); }
      },
    }) : null,
    modal && modal.kind === 'addHost' ? h(AddHostModal, {
      onClose: () => setModal(null),
      onSubmit: async (value) => {
        try {
          const result = await rpc('hosts.addManual', { host: value });
          setModal(null);
          await reloadHosts();
          if (result.host) { setHostId(result.host.id); connectHost(result.host.id); }
          notify(t('toast.created') + ': ' + (result.host?.name || value.name), 'success');
        } catch (error) { notify(error.message, 'error'); }
      },
    }) : null,
    modal && modal.kind === 'picker' ? h(WorkspacePickerModal, {
      hostId: modal.hostId,
      host: hosts.find((item) => item.id === modal.hostId),
      recent: workspaces.filter((item) => item.hostId === modal.hostId),
      rpc,
      onClose: () => setModal(null),
      onPick: addWorkspace,
    }) : null,
    modal && modal.kind === 'password' ? h(PasswordModal, {
      host: hosts.find((item) => item.id === modal.hostId),
      onClose: () => setModal(null),
      onSubmit: async (password) => {
        try {
          const result = await rpc('host.password', { hostId: modal.hostId, password });
          setStatuses((prev) => ({ ...prev, [modal.hostId]: { state: 'online', latencyMs: result.latencyMs, error: '' } }));
          setModal(null);
          if (wsRef.current) refreshHarness(modal.hostId, wsRef.current, false);
        } catch (error) { notify(error.message, 'error'); }
      },
    }) : null,
    renameSession ? h(RenameSessionModal, {
      session: renameSession,
      onClose: () => setRenameSession(null),
      onSubmit: submitRename,
    }) : null,
    portsOpen ? h(PortsModal, {
      hostId: workspace?.hostId || hostId,
      hostName: host?.name,
      forwards,
      onClose: () => setPortsOpen(false),
      onAdd: addForward,
      onRemove: removeForward,
      onOpen: openForward,
    }) : null,
    modal && modal.kind === 'custom' ? h(CustomAgentModal, {
      onClose: () => setModal(null),
      onSubmit: async (command) => {
        setModal(null);
        if (!command) return;
        await launch({ name: command.split(/\s+/)[0] }, command);
      },
    }) : null);
}
