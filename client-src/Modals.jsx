import { React, h, t } from './runtime.js';
import { BackIcon, FolderIcon, LockIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons.jsx';
import { Button, IconButton, Modal, SpinnerText, basename, dirname, joinPath } from './ui.jsx';

export function AddHostModal({ onClose, onSubmit }) {
  const [form, setForm] = React.useState({
    name: '', hostName: '', user: '', port: 22, identityFile: '', proxyJump: '',
  });
  const [busy, setBusy] = React.useState(false);
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const submit = async () => {
    if (!form.hostName.trim()) return;
    setBusy(true);
    try { await onSubmit({ ...form, port: Number(form.port) || 22 }); } finally { setBusy(false); }
  };
  return h(Modal, {
    title: t('host.addTitle'),
    subtitle: t('host.fromConfig'),
    width: 560,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: busy || !form.hostName.trim(), onClick: submit }, busy ? t('misc.loading') : t('dlg.save')),
    ],
  },
  h('div', { className: 'ra-form-grid' },
    h('label', { className: 'ra-field' }, h('span', { className: 'ra-field-label' }, t('host.name')), h('input', { className: 'ra-input', value: form.name, onChange: set('name'), placeholder: 'gpu-lab' })),
    h('label', { className: 'ra-field' }, h('span', { className: 'ra-field-label' }, t('host.host')), h('input', { className: 'ra-input', value: form.hostName, onChange: set('hostName'), placeholder: '10.0.0.12 or server.example.com' })),
    h('label', { className: 'ra-field' }, h('span', { className: 'ra-field-label' }, t('host.user')), h('input', { className: 'ra-input', value: form.user, onChange: set('user'), placeholder: 'root' })),
    h('label', { className: 'ra-field' }, h('span', { className: 'ra-field-label' }, t('host.port')), h('input', { className: 'ra-input', value: form.port, onChange: set('port'), inputMode: 'numeric', placeholder: '22' })),
    h('label', { className: 'ra-field ra-span-2' }, h('span', { className: 'ra-field-label' }, t('host.key')), h('input', { className: 'ra-input', value: form.identityFile, onChange: set('identityFile'), placeholder: '~/.ssh/id_ed25519' })),
    h('label', { className: 'ra-field ra-span-2' }, h('span', { className: 'ra-field-label' }, t('host.jump')), h('input', { className: 'ra-input', value: form.proxyJump, onChange: set('proxyJump'), placeholder: 'bastion' }))));
}

export function PasswordModal({ host, onClose, onSubmit }) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    if (!password) return;
    setBusy(true);
    try { await onSubmit(password); } finally { setBusy(false); }
  };
  return h(Modal, {
    title: t('password.title'),
    width: 440,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: busy || !password, onClick: submit }, busy ? t('misc.loading') : t('dlg.connect')),
    ],
  },
  h('div', { className: 'ra-password' },
    h('div', { className: 'ra-password-icon' }, h(LockIcon, { size: 22 })),
    h('p', { className: 'ra-muted' }, t('password.hint', { host: host ? `${host.name} (${host.detail})` : 'the host' })),
    h('label', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('password.field')),
      h('input', {
        className: 'ra-input', type: 'password', autoFocus: true, value: password,
        onChange: (event) => setPassword(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
      }))));
}

export function CustomAgentModal({ onClose, onSubmit, initial = '' }) {
  const [command, setCommand] = React.useState(initial);
  return h(Modal, {
    title: t('agent.customTitle'),
    subtitle: t('agent.customHint'),
    width: 560,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: !command.trim(), onClick: () => onSubmit(command.trim()) }, t('agent.launch')),
    ],
  },
  h('label', { className: 'ra-field' },
    h('span', { className: 'ra-field-label' }, t('misc.new')),
    h('input', {
      className: 'ra-input ra-mono', autoFocus: true, value: command,
      placeholder: 'kimi --help',
      onChange: (event) => setCommand(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && command.trim()) onSubmit(command.trim()); },
    })),
  h('div', { className: 'ra-examples' },
    ['kimi', 'claude', 'codex', 'python -i', 'htop', 'bash'].map((item) => h('button', {
      key: item, type: 'button', className: 'ra-chip', onClick: () => setCommand(item),
    }, item))));
}

function NotificationSettings({ enabled, onChange, onTest }) {
  const [testing, setTesting] = React.useState(false);
  const test = async () => {
    setTesting(true);
    try { await onTest(); } finally { setTesting(false); }
  };
  return h('div', { className: 'ra-field' },
    h('label', { className: 'ra-notification-toggle' },
      h('input', { type: 'checkbox', checked: enabled, onChange: event => onChange(event.target.checked) }),
      h('span', { className: 'ra-field-label' }, t('settings.notifications'))),
    h('p', { className: 'ra-muted ra-about' }, t('settings.notificationsHint')),
    h(Button, { disabled: !enabled || testing, onClick: test }, testing ? t('misc.loading') : t('settings.testNotification')));
}

export function SettingsModal({ settings, configPath, hosts, stateDir, onClose, onSave, onRemoveManual, onTestNotification }) {
  const [form, setForm] = React.useState({
    sshConfigPath: settings?.sshConfigPath || configPath || '',
    strictHostKeyChecking: settings?.strictHostKeyChecking || 'accept-new',
    controlPersistSeconds: settings?.controlPersistSeconds || 600,
    notificationsEnabled: settings?.notificationsEnabled !== false,
  });
  const manual = (hosts || []).filter((item) => item.source === 'manual');
  return h(Modal, {
    title: t('settings.title'),
    width: 620,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', onClick: () => onSave({ ...form, controlPersistSeconds: Number(form.controlPersistSeconds) || 600 }) }, t('settings.save')),
    ],
  },
  h('div', { className: 'ra-settings' },
    h('label', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('settings.sshConfig')),
      h('input', { className: 'ra-input ra-mono', value: form.sshConfigPath, onChange: (event) => setForm((prev) => ({ ...prev, sshConfigPath: event.target.value })) })),
    h('label', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('settings.hostKey')),
      h('select', {
        className: 'ra-input',
        value: form.strictHostKeyChecking,
        onChange: (event) => setForm((prev) => ({ ...prev, strictHostKeyChecking: event.target.value })),
      },
      h('option', { value: 'accept-new' }, 'accept-new'),
      h('option', { value: 'yes' }, 'yes'),
      h('option', { value: 'no' }, 'no'))),
    h('label', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('settings.persist')),
      h('input', { className: 'ra-input', type: 'number', value: form.controlPersistSeconds, onChange: (event) => setForm((prev) => ({ ...prev, controlPersistSeconds: event.target.value })) })),
    h('div', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('settings.stateDir')),
      h('div', { className: 'ra-mono ra-muted' }, stateDir || '~/.dsh/remote-agent')),
    h('div', { className: 'ra-divider' }),
    settings?.notificationPlatform?.available ? h(NotificationSettings, {
      enabled: form.notificationsEnabled,
      onChange: enabled => setForm(prev => ({ ...prev, notificationsEnabled: enabled })),
      onTest: onTestNotification,
    }) : null,
    h('div', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('settings.hosts')),
      manual.length
        ? manual.map((item) => h('div', { key: item.id, className: 'ra-manual-row' },
          h('div', null, h('div', null, item.name), h('div', { className: 'ra-muted ra-mono' }, item.detail)),
          h(Button, { variant: 'ghost', onClick: () => onRemoveManual(item.id) }, t('conn.remove'))))
        : h('div', { className: 'ra-muted' }, t('settings.noManual'))),
    h('p', { className: 'ra-muted ra-about' }, t('settings.about'))));
}

export function WorkspacePickerModal({ hostId, host, recent = [], rpc, onClose, onPick }) {
  const [path, setPath] = React.useState(recent[0]?.path || '');
  const [input, setInput] = React.useState(recent[0]?.path || '');
  const [entries, setEntries] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');

  const load = React.useCallback(async (target) => {
    setLoading(true);
    setError('');
    try {
      let resolve = target || '/';
      if (resolve === '~') {
        const home = await rpc('fs.home', { hostId });
        resolve = home.home || '/';
      }
      const listed = await rpc('fs.list', { hostId, path: resolve });
      if (!listed.ok) throw new Error(listed.message);
      setEntries((listed.entries || []).filter((entry) => entry.type === 'dir'));
      setPath(listed.path);
      setInput(listed.path);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [hostId, rpc]);

  React.useEffect(() => {
    (async () => {
      try {
        const home = await rpc('fs.home', { hostId });
        const target = recent[0]?.path || home.home || '/';
        await load(target);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    })();
  }, []);

  const go = (target) => load(target || input);
  const createFolder = async () => {
    if (!newName.trim()) return;
    try {
      const result = await rpc('fs.mkdir', { hostId, path: joinPath(path, newName.trim()) });
      if (!result.ok) throw new Error(result.message);
      setNewName('');
      setCreating(false);
      await load(joinPath(path, newName.trim()));
    } catch (err) {
      setError(err.message);
    }
  };

  const parent = dirname(path);
  const canUp = path && path !== '/';
  return h(Modal, {
    title: t('ws.pick'),
    subtitle: host ? `${host.name} · ${host.detail}` : '',
    width: 680,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: !path || loading, onClick: () => onPick(path) }, t('ws.select')),
    ],
  },
  h('div', { className: 'ra-picker' },
    recent.length ? h('div', { className: 'ra-recent' },
      h('span', { className: 'ra-muted' }, t('ws.recent')),
      recent.slice(0, 5).map((item) => h('button', { key: item.id, type: 'button', className: 'ra-chip', onClick: () => go(item.path) }, item.name))) : null,
    h('div', { className: 'ra-picker-bar' },
      h(IconButton, { title: t('misc.up'), disabled: !canUp, onClick: () => go(parent) }, h(BackIcon, { size: 15, style: { transform: 'rotate(90deg)' } })),
      h('input', {
        className: 'ra-input ra-mono',
        value: input,
        onChange: (event) => setInput(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') go(input); },
        spellCheck: false,
      }),
      h(IconButton, { title: t('misc.refresh'), onClick: () => go(path) }, h(RefreshIcon, { size: 15 })),
      h(IconButton, { title: t('ws.newFolder'), onClick: () => setCreating((value) => !value) }, h(PlusIcon, { size: 15 }))),
    creating ? h('div', { className: 'ra-picker-bar' },
      h('input', {
        className: 'ra-input', autoFocus: true, value: newName, placeholder: t('prompt.newFolder'),
        onChange: (event) => setNewName(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') createFolder(); },
      }),
      h(Button, { variant: 'primary', onClick: createFolder }, t('dlg.create'))) : null,
    h('div', { className: 'ra-picker-list' },
      loading ? h('div', { className: 'ra-picker-note' }, h(SpinnerText, { label: t('misc.loading') }))
        : error ? h('div', { className: 'ra-picker-note is-error' }, error)
          : entries.length === 0 ? h('div', { className: 'ra-picker-note' }, t('files.emptyDir'))
            : entries.map((entry) => h('button', {
              key: entry.path, type: 'button', className: 'ra-picker-row',
              onClick: () => go(entry.path),
              onDoubleClick: () => onPick(entry.path),
            }, h(FolderIcon, { size: 15 }), h('span', { className: 'ra-picker-name' }, entry.name), h('span', { className: 'ra-picker-meta' }, entry.mode || '')))),
    h('div', { className: 'ra-picker-path' }, h('span', { className: 'ra-muted' }, t('misc.path')), h('span', { className: 'ra-mono' }, path))));
}

export function PortsModal({ hostId, hostName, forwards, onClose, onAdd, onRemove, onOpen }) {
  const [remotePort, setRemotePort] = React.useState('');
  const [localPort, setLocalPort] = React.useState('');
  const [remoteHost, setRemoteHost] = React.useState('localhost');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const add = async () => {
    const remote = Number(remotePort);
    if (!remote) { setError(t('ports.remotePort')); return; }
    setBusy(true);
    setError('');
    try {
      const result = await onAdd({
        hostId,
        remotePort: remote,
        localPort: Number(localPort) || undefined,
        remoteHost: remoteHost.trim() || 'localhost',
      });
      if (result) {
        setRemotePort('');
        setLocalPort('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const mine = (forwards || []).filter((forward) => !hostId || forward.hostId === hostId);
  return h(Modal, {
    title: t('ports.title'),
    subtitle: t('ports.hint'),
    width: 620,
    onClose,
    footer: [h(Button, { key: 'c', onClick: onClose }, t('dlg.close'))],
  },
  h('div', { className: 'ra-ports' },
    mine.length
      ? h('div', { className: 'ra-port-list' }, mine.map((forward) => h('div', { key: forward.id, className: 'ra-port-row' },
        h('div', { className: 'ra-port-main' },
          h('div', { className: 'ra-port-title' }, `127.0.0.1:${forward.localPort}`, h('span', { className: 'ra-port-arrow' }, '→'), `${forward.hostName || ''}:${forward.remotePort}`),
          h('div', { className: 'ra-port-sub' }, `${forward.remoteHost}:${forward.remotePort}`)),
        h(Button, { variant: 'ghost', onClick: () => onOpen(forward) }, t('ports.open')),
        h(IconButton, { title: t('ports.remove'), danger: true, onClick: () => onRemove(forward) }, h(TrashIcon, { size: 14 })))))
      : h('div', { className: 'ra-hint' }, t('ports.empty')),
    h('div', { className: 'ra-divider' }),
    h('div', { className: 'ra-port-form' },
      h('label', { className: 'ra-field' },
        h('span', { className: 'ra-field-label' }, t('ports.remotePort')),
        h('input', { className: 'ra-input', inputMode: 'numeric', value: remotePort, placeholder: '3000', onChange: (event) => setRemotePort(event.target.value) })),
      h('label', { className: 'ra-field' },
        h('span', { className: 'ra-field-label' }, t('ports.localPort')),
        h('input', { className: 'ra-input', inputMode: 'numeric', value: localPort, placeholder: String(remotePort || '') || '3000', onChange: (event) => setLocalPort(event.target.value) })),
      h('label', { className: 'ra-field' },
        h('span', { className: 'ra-field-label' }, t('ports.remoteHost')),
        h('input', { className: 'ra-input ra-mono', value: remoteHost, placeholder: 'localhost', onChange: (event) => setRemoteHost(event.target.value) })),
      h(Button, { variant: 'primary', disabled: busy || !hostId, onClick: add }, busy ? t('misc.loading') : t('ports.add'))),
    error ? h('div', { className: 'ra-file-banner is-error' }, error) : null,
    !hostId ? h('div', { className: 'ra-hint' }, t('welcome.pickHost')) : null));
}

export function RenameSessionModal({ session, onClose, onSubmit }) {
  const [title, setTitle] = React.useState(session?.title || '');
  const submit = () => {
    const next = title.trim();
    if (next) onSubmit(next);
  };
  return h(Modal, {
    title: t('sessions.renameTitle'),
    subtitle: t('sessions.renameHint'),
    width: 480,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: !title.trim(), onClick: submit }, t('dlg.save')),
    ],
  },
  h('label', { className: 'ra-field' },
    h('span', { className: 'ra-field-label' }, t('sessions.name')),
    h('input', {
      className: 'ra-input',
      autoFocus: true,
      value: title,
      maxLength: 120,
      placeholder: t('sessions.namePlaceholder'),
      onChange: (event) => setTitle(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
    })));
}
