# Release process

This package uses an ordinary GitHub Release for a prebuilt DSH bundle. No
install-time scripts or native modules are needed.

1. Update source and package versions together (`package.json`,
   `package-lock.json`, `index.js`). Keep `engines.dsh` realistic for the tested
   host API, and keep the upstream `@deepseek-ai/*` runtime out of dependencies.
2. Run `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `npm test`.
3. Produce `npm pack --pack-destination release/`. The expected artifact is
   `dsh-remote-agent-<version>.tgz`; upload a copy **without the version** as
   `dsh-remote-agent.tgz` for the stable `latest/download` link.
4. Publish the semver release/tag and upload the package built from the same
   commit. Never rewrite an existing release or delete its tag without an
   explicit owner request.
5. To change the official catalog entry, update only
   `data/plugins/BeastyZ__dsh-remote-agent.yml` in the owner's fork of
   awesome-dsh-plugin/awesome-dsh-plugin, then open a PR. For runtime updates,
   a pinned tag tarball is preferable to modifying version-specific links.

## Current public release notes (v1.0.0)

First public release of the SSH remote workbench for DSH Desktop/Web.

- Use configured SSH connections or manual entries to launch a PTY for Kimi
  Code, Codex, Claude Code, or a custom command in a saved Linux workspace.
- Persistent terminal records: recent saved display survives DSH restarts;
  new tmux sessions can automatically reattach to the same remote process.
  Nothing is deleted unless explicitly confirmed.
- Files: tree, editor, rendered previews, upload/download, clipboard copy/paste,
  and absolute/relative paths. Git: diff, staging, commits, worktrees. Ports:
  loopback SSH forwarding and detected-port shortcuts.
- xterm Canvas fixes for CJK right-edge clipping; replayed terminal data is
  presentation-only and cannot echo protocol replies back to the remote shell.
- Tested on DSH 0.2.2-rc.1 (macOS) with a Linux/OpenSSH/tmux host. `npm test`
  has 12 passing local unit/integration cases; optional live-SSH tests are
  opt-in and isolated from user sessions. Initial compatibility declaration is
  conservative; it is not a claim of validation on every OS/DSH combination.

Market category: remote. Suggested description:
`SSH workbench for launching remote agent CLIs with durable sessions, terminal,
file editing, Git worktrees and local port forwarding.`
中文：`连接 Linux 服务器的 Agent 工作台，支持持久会话、远程终端、文件编辑、Git worktree 和端口转发。`

The catalog requires a **real creation timestamp at least one day old** plus
`dsh-plugin` topic. Do not claim acceptance until the catalog PR has merged and
its site has been rebuilt.
