// Opt-in protocol test, not a GUI automation test. Uses a new remote tmux
// server only, and a local headless xterm only as its SGR encoder and renderer.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomBytes} from 'node:crypto'
import os from 'node:os'
import Headless from '@xterm/headless'
import {handleTerminalWheel} from '../client-src/terminal-wheel.js'
const require=createRequire(import.meta.url)
const pty=require('node-pty')
const exec=promisify(execFile)
const alias=process.env.DSH_TEST_SSH_ALIAS
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('alternate mouse VT200 path is delegated',()=>{
 const fake={buffer:{active:{type:'alternate'}},modes:{mouseTrackingMode:'vt200'}}
 assert.equal(handleTerminalWheel({deltaY:-40,deltaMode:0},fake),true)
})

test('real SSH tmux mouse wheel preserves literal readline and actual pane state',{skip:!alias||os.platform()!=='darwin',timeout:45000},async t=>{
 let owned=false
 let child
 let term
 const socket='dsh-wheel-'+randomBytes(6).toString('hex')
 const session='probe-'+process.pid
 const typed='UNSUBMITTED_INPUT_ABCDEFGHIJ'
 const data=[]
 let output=''
 const run=async script=>{
  const args=['-o','BatchMode=yes','-o','ConnectTimeout=8',alias,script]
  try{return (await exec('/usr/bin/ssh',args,{timeout:7000,maxBuffer:64*1024})).stdout}
  catch(e){return (e.stdout||'')+'\nFAIL='+e.code}
 }
 const screen=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true)||'').join('\n')
 const waitFor=async text=>{
  for(let i=0;i<100;i++){
   if(term&&screen().includes(text))return
   await sleep(100)
  }
  throw Error('screen timeout waiting for '+text+'; screen tail='+JSON.stringify(screen().slice(-800)))
 }
 const state=async label=>{
  return (await run(`tmux -L ${socket} display-message -p -t ${session} '#{pane_in_mode};#{scroll_position}'`)).trim()
 }
 const fire=direction=>{const button=4; const action=direction<0?0:1;return term._core.coreMouseService.triggerMouseEvent({button,action,col:12,row:12,x:96,y:192,ctrl:false,alt:false,shift:false})}

 t.diagnostic('isolated test server: '+socket)
 try{
  const init=await run(`tmux -L ${socket} -f /dev/null new-session -d -s ${session} -x 100 -y 28 'bash --noprofile --norc' && tmux -L ${socket} set-option -g mouse on && tmux -L ${socket} set-option -g history-limit 200 && tmux -L ${socket} set-option -g status off && tmux -L ${socket} display-message -p -t ${session} '#{pane_id}'`)
  assert.match(init.trim(),/%\d+/)
  owned=true
  child=pty.spawn('/usr/bin/ssh',['-tt','-o','BatchMode=yes','-o','ConnectTimeout=8',alias,`env TERM=screen-256color tmux -L ${socket} attach-session -t ${session}`],{cols:100,rows:28,env:process.env})
  child.onExit(({exitCode})=>t.diagnostic('PTY exited '+exitCode))
  child.onData(chunk=>{
   data.push(chunk)
   if(term)void term.write(chunk)
  })
  term=new Headless.Terminal({cols:100,rows:28,scrollback:2000,allowProposedApi:true})
  term.onData(chunk=>{
   if(/^\x1b\[</.test(chunk)){
    child.write(chunk)
   }
  })
  await sleep(1500)
  for(let i=0;i<50 && !/bash-[0-9.]+#/.test(screen());i++)await sleep(100)
  if(!/bash-[0-9.]+#/.test(screen()))throw new Error('awaited real bash prompt, got '+JSON.stringify(data.join('').slice(-600)))
  child.write('for i in $(seq 1 80); do printf "ROLL_BACK_${i}\\n"; done; printf "READY_marker\\n"\r')
  await waitFor('READY_marker')
  const before=screen()
  assert(before.includes('ROLL_BACK_80'),'80 lines were produced')
  assert(!before.split('\n').includes('ROLL_BACK_1'),'initial bottom is far from the head')
  child.write("read -e -r -p 'READ_PROMPT> ' INPUT; printf 'FINAL_INPUT=%s\\n' \"$INPUT\"\r")
  await waitFor('READ_PROMPT>')
  child.write(typed)
  await waitFor(typed)
  assert.equal(await state(), '0;')

  await new Promise(resolve=>term.write('\x1b[?1000h\x1b[?1006h',resolve))
  assert.equal(term.modes.mouseTrackingMode,'vt200')
  assert.equal(term._core.coreMouseService.activeEncoding,'SGR')
  const beforeFire=output.length
  for(let i=0;i<12;i++){fire(-1);await sleep(40)}
  t.diagnostic('after upward mouse packets: '+await state())
  const up=await state()
  const [mode,scroll]=up.split(';')
  assert.equal(mode,'1','tmux must enter copy mode from SGR wheel-up')
  assert(Number(scroll)>0,'tmux scroll_position must be greater than zero')
  const older=screen()
  assert(older.includes('ROLL_BACK_1'),'moved to the oldest output')
  assert(!older.includes('ROLL_BACK_80'),'old view no longer follows latest output')
  for(let i=0;i<90;i++){fire(65);await sleep(5)}
  await sleep(800)
  const down=await state()
  t.diagnostic('after downward mouse packets: '+down)
  assert.equal(down,'0;','reaching bottom clears copy mode')
  const newest=screen()
  assert(newest.includes('ROLL_BACK_80'),'returned to bottom view')
  assert(newest.includes(typed),'typed readline content unchanged')
  child.write('\r')
  await waitFor('FINAL_INPUT='+typed,'same exact final string')
  t.diagnostic('mouse wheel integration passed')
 }catch(error){
  if(term)t.diagnostic('screen on failure: '+screen().slice(-4000))
  throw error
 }finally{
  if(child)try{child.kill('SIGTERM')}catch{}
  if(term)term.dispose()
  if(owned)await run(`tmux -L ${socket} kill-server`)
  t.diagnostic('cleanup requested only for this unique test socket')
 }
})
