import { React, h, t } from './runtime.js';
import {
  BackIcon, BranchIcon, CheckIcon, ChevronIcon, CopyIcon, PlusIcon, RefreshIcon, TrashIcon, TerminalIcon,
} from './icons.jsx';
import { Button, IconButton, Modal, SpinnerText, copyText } from './ui.jsx';

function groupChanges(entries) {
  const staged = [];
  const unstaged = [];
  for (const entry of entries || []) {
    if (entry.staged) staged.push(entry);
    if (entry.unstaged || entry.untracked) unstaged.push(entry);
  }
  return { staged, unstaged };
}

function statusLabel(entry) {
  if (entry.untracked) return 'U';
  if (entry.status === 'R') return 'R';
  if (entry.status === 'C') return 'C';
  return entry.status || 'M';
}

function diffClass(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'is-meta';
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-del';
  return '';
}

export function DiffView({ diff, onClose, copy }) {
  const lines = String(diff.diff || '').replace(/\n$/, '').split('\n');
  return h('div', { className: 'ra-diff-view' },
    h('div', { className: 'ra-fileview-head' },
      h(IconButton, { title: t('misc.back'), onClick: onClose }, h(BackIcon, { size: 16 })),
      h('div', { className: 'ra-fileview-title' },
        h('div', { className: 'ra-fileview-name', title: diff.path }, diff.path),
        h('div', { className: 'ra-fileview-sub' }, diff.staged ? t('git.staged') : diff.untracked ? t('git.untracked') : t('git.changes'))),
      h('div', { className: 'ra-head-actions' },
        h(IconButton, { title: t('files.copyPath'), onClick: () => copy(diff.path) }, h(CopyIcon, { size: 15 })))),
    h('div', { className: 'ra-diff-body' },
      diff.diff
        ? h('pre', { className: 'ra-diff-pre' }, lines.map((line, index) => h('div', {
          key: index,
          className: 'ra-diff-line ' + diffClass(line),
        }, line || ' ')))
        : h('div', { className: 'ra-file-empty' }, t('git.noDiff'))));
}

function BranchPrompt({ onClose, onSubmit }) {
  const [branch, setBranch] = React.useState('');
  const [base, setBase] = React.useState('HEAD');
  const submit = () => { if (branch.trim()) onSubmit(branch.trim(), base.trim() || 'HEAD'); };
  return h(Modal, {
    title: t('git.newWorktree'),
    subtitle: t('git.worktreeHint'),
    width: 480,
    onClose,
    footer: [
      h(Button, { key: 'c', onClick: onClose }, t('dlg.cancel')),
      h(Button, { key: 's', variant: 'primary', disabled: !branch.trim(), onClick: submit }, t('dlg.create')),
    ],
  },
  h('label', { className: 'ra-field' },
    h('span', { className: 'ra-field-label' }, t('git.branchName')),
    h('input', {
      className: 'ra-input ra-mono', autoFocus: true, value: branch, placeholder: 'feat/my-change',
      onChange: (event) => setBranch(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
    })),
  h('label', { className: 'ra-field' },
    h('span', { className: 'ra-field-label' }, t('git.baseRef')),
    h('input', {
      className: 'ra-input ra-mono', value: base,
      onChange: (event) => setBase(event.target.value),
      placeholder: 'HEAD',
    })));
}

export function GitPanel({ hostId, workspace, info, loading, rpc, notify, onRefresh, onWorkspaceAdded, onWorkspaceRemoved }) {
  const [diff, setDiff] = React.useState(null);
  const [message, setMessage] = React.useState('');
  const [allChanges, setAllChanges] = React.useState(true);
  const [busy, setBusy] = React.useState('');
  const [worktrees, setWorktrees] = React.useState([]);
  const [showWorktrees, setShowWorktrees] = React.useState(false);
  const [prompt, setPrompt] = React.useState(null);
  const [confirm, setConfirm] = React.useState(null);
  const [error, setError] = React.useState('');

  const loadWorktrees = React.useCallback(async () => {
    if (!workspace || !info?.isRepo) return;
    try {
      const result = await rpc('git.worktrees', { hostId, path: workspace.path });
      setWorktrees(result.worktrees || []);
    } catch (err) {
      setError(err.message);
    }
  }, [hostId, workspace?.path, info?.isRepo, rpc]);

  React.useEffect(() => {
    setDiff(null);
    setError('');
    setWorktrees([]);
    setShowWorktrees(false);
    if (workspace && info?.isRepo) loadWorktrees();
  }, [workspace?.id, info?.isRepo]);

  const refresh = async () => {
    await onRefresh();
    if (info?.isRepo) await loadWorktrees();
  };

  const copy = async (value) => {
    const ok = await copyText(value);
    notify(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'success' : 'error');
  };

  const openDiff = async (entry, staged) => {
    setError('');
    try {
      const result = await rpc('git.diff', {
        hostId, path: workspace.path, file: entry.path, staged, untracked: entry.untracked,
      });
      setDiff({ ...result, path: entry.path, staged, untracked: entry.untracked });
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const stage = async (entry) => {
    setBusy('stage');
    try {
      await rpc('git.stage', { hostId, path: workspace.path, files: entry ? [entry.path] : [] });
      await refresh();
      if (entry) await openDiff(entry, true);
    } catch (err) { notify(err.message, 'error'); } finally { setBusy(''); }
  };

  const unstage = async (entry) => {
    setBusy('unstage');
    try {
      await rpc('git.unstage', { hostId, path: workspace.path, files: entry ? [entry.path] : [] });
      await refresh();
      setDiff(null);
    } catch (err) { notify(err.message, 'error'); } finally { setBusy(''); }
  };

  const commit = async () => {
    if (!message.trim()) return;
    setBusy('commit');
    setError('');
    try {
      const result = await rpc('git.commit', { hostId, path: workspace.path, message, all: allChanges });
      setMessage('');
      setDiff(null);
      notify(`${t('git.committed')}: ${result.hash || ''}`, 'success');
      await refresh();
    } catch (err) {
      setError(err.message);
      notify(err.message, 'error');
    } finally { setBusy(''); }
  };

  const createWorktree = async (branch, base) => {
    setPrompt(null);
    setBusy('worktree');
    setError('');
    try {
      const result = await rpc('git.worktreeAdd', { hostId, path: workspace.path, branch, base });
      notify(`${t('git.worktreeCreated')}: ${result.path}`, 'success');
      if (result.workspace) onWorkspaceAdded?.(result.workspace);
      await refresh();
    } catch (err) {
      setError(err.message);
      notify(err.message, 'error');
    } finally { setBusy(''); }
  };

  const useWorktree = async (path) => {
    try {
      const result = await rpc('ws.add', { hostId, path });
      onWorkspaceAdded?.(result.workspace);
    } catch (err) { notify(err.message, 'error'); }
  };

  const removeWorktree = async (path) => {
    setConfirm(null);
    try {
      const result = await rpc('git.worktreeRemove', { hostId, path: workspace.path, worktree: path });
      if (result.removedWorkspaceId) onWorkspaceRemoved?.(result.removedWorkspaceId);
      notify(t('git.worktreeRemoved'), 'success');
      await refresh();
    } catch (err) { notify(err.message, 'error'); }
  };

  if (diff) {
    return h(DiffView, { diff, onClose: () => setDiff(null), copy });
  }

  if (!info) {
    return h('div', { className: 'ra-git' }, h('div', { className: 'ra-file-loading' }, loading ? h(SpinnerText, { label: t('git.loading') }) : t('git.notRepo')));
  }
  if (!info.isRepo) {
    return h('div', { className: 'ra-git' },
      h('div', { className: 'ra-file-empty' },
        h('div', null, t('git.notRepo')),
        h('div', { className: 'ra-muted' }, t('git.notRepoHint')),
        h(Button, { onClick: refresh }, t('git.refresh'))));
  }

  const { staged, unstaged } = groupChanges(info.entries);
  const currentWorktree = worktrees.find((item) => item.path === workspace.path);
  return h('div', { className: 'ra-git' },
    h('div', { className: 'ra-git-head' },
      h('div', { className: 'ra-git-branch' },
        h(BranchIcon, { size: 14 }),
        h('span', { title: info.root }, info.detached ? 'detached' : info.branch || '(no branch)'),
        info.ahead ? h('span', { className: 'ra-git-count' }, `↑${info.ahead}`) : null,
        info.behind ? h('span', { className: 'ra-git-count' }, `↓${info.behind}`) : null),
      h('div', { className: 'ra-head-actions' },
        h(IconButton, { title: t('git.worktrees'), active: showWorktrees, onClick: () => { setShowWorktrees((value) => !value); loadWorktrees(); } }, h(TerminalIcon, { size: 15 })),
        h(IconButton, { title: t('git.newWorktree'), onClick: () => setPrompt('branch') }, h(PlusIcon, { size: 15 })),
        h(IconButton, { title: t('git.refresh'), onClick: refresh }, h(RefreshIcon, { size: 15 })))),
    error ? h('div', { className: 'ra-file-banner is-error' }, error) : null,
    showWorktrees ? h('div', { className: 'ra-worktrees' },
      h('div', { className: 'ra-git-section-head' },
        h('span', null, t('git.worktrees')),
        h(IconButton, { title: t('git.newWorktree'), onClick: () => setPrompt('branch') }, h(PlusIcon, { size: 13 }))),
      worktrees.length
        ? worktrees.map((item) => h('div', { key: item.path, className: 'ra-worktree-row' },
          h('div', { className: 'ra-worktree-main' },
            h('div', { className: 'ra-worktree-branch' }, item.branch || (item.detached ? 'detached' : '—')),
            h('div', { className: 'ra-worktree-path', title: item.path }, item.path)),
          item.path === info.root || item.path === workspace.path
            ? h('span', { className: 'ra-worktree-current' }, t('git.current'))
            : h('div', { className: 'ra-head-actions' },
              item.path !== workspace.path ? h(Button, { variant: 'ghost', onClick: () => useWorktree(item.path) }, t('git.openWorktree')) : null,
              h(IconButton, { title: t('git.removeWorktree'), danger: true, onClick: () => setConfirm(item) }, h(TrashIcon, { size: 13 })))))
        : h('div', { className: 'ra-hint' }, t('git.noWorktrees'))) : null,
    h('div', { className: 'ra-git-scroll' },
      h('div', { className: 'ra-git-section-head' },
        h('span', null, t('git.staged'), h('span', { className: 'ra-count' }, staged.length)),
        staged.length ? h(Button, { variant: 'ghost', onClick: () => unstage(null), disabled: busy === 'unstage' }, t('git.unstageAll')) : null),
      staged.length
        ? staged.map((entry) => h('div', {
          key: 's-' + entry.path,
          className: 'ra-change-row',
          onClick: () => openDiff(entry, true),
        },
        h('span', { className: 'ra-change-status is-' + statusLabel(entry).toLowerCase() }, statusLabel(entry)),
        h('span', { className: 'ra-change-path', title: entry.path }, entry.path),
        h(IconButton, {
          title: t('git.unstage'),
          onClick: (event) => { event.stopPropagation(); unstage(entry); },
        }, h(BackIcon, { size: 13, style: { transform: 'rotate(90deg)' } }))))
        : h('div', { className: 'ra-git-empty' }, t('git.noStaged')),
      h('div', { className: 'ra-git-section-head' },
        h('span', null, t('git.changes'), h('span', { className: 'ra-count' }, unstaged.length)),
        unstaged.length ? h(Button, { variant: 'ghost', onClick: () => stage(null), disabled: busy === 'stage' }, t('git.stageAll')) : null),
      unstaged.length
        ? unstaged.map((entry) => h('div', {
          key: 'u-' + entry.path,
          className: 'ra-change-row',
          onClick: () => openDiff(entry, false),
        },
        h('span', { className: 'ra-change-status is-' + statusLabel(entry).toLowerCase() }, statusLabel(entry)),
        h('span', { className: 'ra-change-path', title: entry.path }, entry.path),
        h(IconButton, {
          title: t('git.stage'),
          onClick: (event) => { event.stopPropagation(); stage(entry); },
        }, h(CheckIcon, { size: 14 }))))
        : h('div', { className: 'ra-git-empty' }, info.clean ? t('git.clean') : t('git.noChanges'))),
    h('div', { className: 'ra-commit' },
      h('textarea', {
        className: 'ra-commit-input',
        rows: 3,
        value: message,
        placeholder: t('git.messagePlaceholder'),
        onChange: (event) => setMessage(event.target.value),
        onKeyDown: (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') commit();
        },
      }),
      h('div', { className: 'ra-commit-actions' },
        h('label', { className: 'ra-check' },
          h('input', { type: 'checkbox', checked: allChanges, onChange: (event) => setAllChanges(event.target.checked) }),
          h('span', null, t('git.allChanges'))),
        h(Button, {
          variant: 'primary',
          disabled: !message.trim() || busy === 'commit',
          onClick: commit,
        }, busy === 'commit' ? t('files.saving') : t('git.commit')))),
    prompt === 'branch' ? h(BranchPrompt, { onClose: () => setPrompt(null), onSubmit: createWorktree }) : null,
    confirm ? h(Modal, {
      title: t('git.removeWorktree'),
      width: 460,
      onClose: () => setConfirm(null),
      footer: [
        h(Button, { key: 'c', onClick: () => setConfirm(null) }, t('dlg.cancel')),
        h(Button, { key: 'd', variant: 'danger', onClick: () => removeWorktree(confirm.path) }, t('dlg.delete')),
      ],
    }, h('div', { className: 'ra-confirm-text' }, t('git.removeWorktreeBody', { path: confirm.path }))) : null);
}
