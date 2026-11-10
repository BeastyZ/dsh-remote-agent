// Presentation-only history. RPC byte offsets follow unicode code units; no
// external limit is passed because the host enforces 64KiB chunks safely.
export async function replayOutput({ term, read, onOutput, isStopped }) {
  let offset = 0
  const write = data => new Promise(resolve => {
    if (isStopped()) { resolve(); return }
    // The completion callback guarantees parser replies from this batch fired
    // before a subsequent batch is delivered. Do not split UTF-8 here.
    term.write(data, resolve)
  })
  while (!isStopped()) {
    const result = await read({ offset, waitMs: 0 })
    if (result.data) {
      await write(result.data)
      offset = result.nextOffset
      onOutput?.(result.data)
    }
    if (result.exited || !result.hasMore) return { offset, result }
  }
  return { offset, result: null }
}
