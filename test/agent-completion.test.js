import test from 'node:test'
import assert from 'node:assert/strict'
import { agentKind, completionSignal, createCompletionScreen, AgentCompletionTracker } from '../host/agent-completion.js'
import { LocalNotifier } from '../host/notifications.js'

const IDLE = [
  '│ • Finished modifying files',
  '│ Ask Codex anything                         95% context left',
  '│ › ',
].join('\r\n')
const BUSY = [
  '│ • Working on it (12s)',
  '│ esc to interrupt',
  '│ › ',
].join('\r\n')
const SHELL = '$ echo done\r\ndone\r\n$ '

function session(text, extra={}) {
  return {id:'t-abc123abc123',title:'Codex Demo',command:'codex',state:'running',total:text.length,start:0,cols:110,rows:28,buffer:text,generation:0,...extra}
}

test('recognizes simple agent commands without promoting shell pipelines', () => {
  assert.equal(agentKind('codex'), 'codex')
  assert.equal(agentKind('/home/user/.local/bin/claude --resume'), 'claude')
  assert.equal(agentKind('exec kimi -p task'), 'kimi')
  assert.equal(agentKind(''), null)
  assert.equal(agentKind('codex && bash'), null)
  assert.equal(agentKind('htop'), null)
})
test('completion needs provider prompt, not a quiet command or response alone', () => {
  assert.deepEqual(completionSignal('Done\n$ echo Done\nuser@host:~$ ', 'codex').ready, false)
  assert.equal(completionSignal('esc to interrupt\n│ Ask Codex anything\n│ › ', 'codex').ready, false)
  assert.equal(completionSignal(IDLE, 'codex').ready, true)
  assert.equal(completionSignal('❯ Type your message  ? for shortcuts', 'claude').ready, true)
})

test('alternate-screen terminal projection detects busy to idle, with exactly one notice', async t => {
  let state = session('\x1b[?1049h\x1b[2J\x1b[H' + IDLE)
  const events=[]
  let now=0
  const tracker = new AgentCompletionTracker({
    sessions:()=>[state],autoStart:false,quietMs:4000,clock:{now:()=>now},
    onComplete: event=>events.push(event),
  })
  t.after(()=>tracker.dispose())
  await tracker.observe() // restored old prompt: no notification
  now=4000
  await tracker.observe()
  assert.equal(events.length,0,'old saved history is presentation only')
  // Inputs here carry only bytes not included in the previous observed total,
  // as TerminalSession's rolling buffer does. Use real cursor movement to
  // update the alternate screen instead of manufacturing malformed deltas.
  state={...state,buffer:'\x1b[1;1H\x1b[J'+BUSY}
  state.start=state.total
  state.total+=state.buffer.length
  await tracker.observe()
  now=8000
  await tracker.observe()
  assert.equal(events.length,0)
  state={...state,buffer:'\x1b[1;1H\x1b[J'+IDLE,start:state.total}
  state.total+=state.buffer.length
  await tracker.observe()
  now=12000
  await tracker.observe()
  assert.equal(events.length,1,'completed turn')
  assert.equal(events[0].reason,'idle')
  await tracker.observe()
  now=16000
  await tracker.observe()
  assert.equal(events.length,1,'timer redraws do not emit duplicates')
})

test('actual headless xterm emulator drives the same busy to complete boundary', async () => {
  const current=session('\x1b[?1049h\x1b[2J\x1b[H'+BUSY)
  const screen=createCompletionScreen(current)
  await screen.project(current)
  assert.equal(completionSignal(screen.text,'codex').busy,true)
  const nextText='\x1b[2J\x1b[H'+IDLE
  const next={...current,buffer:nextText,start:current.total,total:current.total+nextText.length}
  await screen.project(next)
  assert.equal(completionSignal(screen.text,'codex').ready,true)
  screen.resize(80,24)
  await screen.project({...next,cols:80,rows:24})
  assert.equal(completionSignal(screen.text,'codex').ready,true)
  assert.deepEqual(screen.text.split('\n').length,24)
  screen.dispose()
})

test('custom program and shell output are never notified', async t => {
  const current=session(SHELL,{command:'htop'})
  const events=[]
  const tracker=new AgentCompletionTracker({sessions:()=>[current],autoStart:false,quietMs:0,onComplete:e=>events.push(e)})
  t.after(()=>tracker.dispose())
  await tracker.observe()
  await tracker.observe()
  assert.equal(events.length,0)
  assert.equal(tracker.states.size,0)
})

test('disconnect is silent; a real agent process exit notifies once', async t => {
  const current=session(BUSY)
  const events=[]
  let now=0
  const tracker=new AgentCompletionTracker({sessions:()=>[current],autoStart:false,quietMs:0,clock:{now:()=>now},onComplete:e=>events.push(e)})
  t.after(()=>tracker.dispose())
  await tracker.observe()
  await tracker.observe()
  await tracker.observe()
  current.state='detached'
  await tracker.observe()
  assert.equal(events.length,0)
  current.generation=1
  current.state='running'
  await tracker.observe()
  current.state='exited'
  current.exitCode=1
  await tracker.observe()
  await tracker.observe()
  assert.equal(events.length,1)
  assert.equal(events[0].exitCode,1)
})

test('macOS sender uses positional OSA arguments and handles platform rejection', async () => {
  const calls=[]
  const notifier=new LocalNotifier({platform:'darwin',run:async(...args)=>{calls.push(args)}})
  await notifier.send({title:'Agent "done"',body:"It's complete; no code execution."})
  assert.equal(calls.length,1)
  assert.equal(calls[0][0],'/usr/bin/osascript')
  assert.deepEqual(calls[0][1].slice(-2),['Agent "done"',"It's complete; no code execution."])
  assert(!calls[0][1].some(arg=>arg.includes('DeepSeek Harness')))
  assert(calls[0][1].some(arg=>arg.includes('on run argv')))
  const unsupported=new LocalNotifier({platform:'linux',run:async()=>{throw Error('not allowed')}})
  await assert.rejects(()=>unsupported.send({}),{code:'UNSUPPORTED'})
  assert.equal(unsupported.capability().available,false)
})
