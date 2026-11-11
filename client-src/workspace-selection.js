export function fitsWorkspace(item, workspace) {
  if (!workspace || !item) return false
  if (workspace.id && item.hostId !== workspace.hostId) return false
  return item.workspaceId ? item.workspaceId === workspace.id : item.cwd === workspace.path
}

export function workspaceSessions(items, workspace) {
  return workspace ? items.filter(item => fitsWorkspace(item, workspace)) : []
}

export function chooseSession(current, previous, sessions) {
  if (current && sessions.some(item => item.id === current)) return current
  if (previous && sessions.some(item => item.id === previous)) return previous
  return sessions.length ? sessions[sessions.length - 1].id : null
}
