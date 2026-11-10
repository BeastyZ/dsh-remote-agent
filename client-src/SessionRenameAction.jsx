import { React, h, t } from './runtime.js';
import { rpc } from './api.js';
import { Modal, Button } from './ui.jsx';
import { EditIcon } from './icons.jsx';

/**
 * A small pencil in the native DSH Session-row hover strip. It renames the
 * chat Session itself (not a remote terminal): the host calls the log-backed
 * sessionTitle service, so the change is durable and pins the title against
 * later automatic generation.
 */
export function SessionRenameAction({ sessionId, displayTitle }) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(displayTitle || '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const start = () => {
    setTitle(displayTitle || '');
    setError('');
    setOpen(true);
  };

  const submit = async () => {
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    setError('');
    try {
      await rpc('session.rename', { sessionId, title: next });
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return h('span', { className: 'ra-native-rename' },
    h('button', {
      type: 'button',
      className: 'ra-native-action',
      title: t('chatRename.action'),
      'aria-label': t('chatRename.action'),
      onClick: start,
    }, h(EditIcon, { size: 12 })),
    open ? h(Modal, {
      title: t('chatRename.title'),
      subtitle: t('chatRename.hint'),
      width: 480,
      onClose: () => setOpen(false),
      footer: [
        h(Button, { key: 'c', onClick: () => setOpen(false) }, t('dlg.cancel')),
        h(Button, { key: 's', variant: 'primary', disabled: busy || !title.trim(), onClick: submit }, busy ? t('misc.loading') : t('dlg.save')),
      ],
    },
    h('label', { className: 'ra-field' },
      h('span', { className: 'ra-field-label' }, t('chatRename.label')),
      h('input', {
        className: 'ra-input',
        autoFocus: true,
        maxLength: 200,
        value: title,
        placeholder: t('chatRename.placeholder'),
        onChange: (event) => setTitle(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
      })),
    error ? h('div', { className: 'ra-file-banner is-error' }, error) : null) : null);
}
