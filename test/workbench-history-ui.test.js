globalThis.IS_REACT_ACT_ENVIRONMENT = true
const previousWindow = globalThis.window
const previousDocument = globalThis.document

import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import {build} from 'esbuild'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const outfile=path.resolve('client-src/.test-workbench-history.cjs')

function text(node){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(text).join(' ');return typeof node==='string'?node:text(node.children)}
const session={id:'t-abc000abc000',hostId:'h',workspaceId:'w',cwd:'/project',title:'Kimi · project',state:'running',persistent:true,generation:0}
const boot={
 hosts:[{id:'h',name:'test host'}],workspaces:[{id:'w',hostId:'h',path:'/project',name:'project'}],
 terminals:[session],lastHostId:'h',lastWorkspaceId:'w',activeTerminals:{w:session.id},warnings:[],
 settings:{notificationPlatform:{available:true},notificationsEnabled:true},
}

test('real Workbench opens scrollback and renders prior model response with real UI runtime',async t=>{
 await build({
  stdin:{contents:`import React from 'react';import {setReact} from './client-src/runtime.js';import {setReactDOM} from './client-src/ui.jsx';import './client-src/i18n.js';import {setLocale} from './client-src/runtime.js';setReact(React);setReactDOM(null);setLocale('en');export {Workbench} from './client-src/Workbench.jsx';`,resolveDir:path.resolve('.'),loader:'jsx'},
  bundle:true,format:'cjs',platform:'node',outfile,external:['react'],jsxFactory:'React.createElement',
  plugins:[{name:'minimal-live-harness',setup(b){
   b.onResolve({filter:/\/TerminalView\.jsx$/},()=>({path:'live-xterm',namespace:'test'}))
   b.onLoad({filter:/^live-xterm$/,namespace:'test'},args=>({contents:`export function TerminalView(){return null};export {TerminalHistory} from ${JSON.stringify(path.resolve('client-src/TerminalHistory.jsx'))};`,loader:'js',resolveDir:path.resolve('client-src')}))
   b.onResolve({filter:/(^|\/)api(\.js)?$/},()=>({path:'api',namespace:'test'}))
    b.onLoad({filter:/^api$/,namespace:'test'},()=>({contents:'export function rpc(method, params){ return globalThis.__historyTestRpc(method, params); }',resolveDir:path.resolve('.')}))
    b.onResolve({filter:/(FilesPanel|GitPanel)/},()=>({path:'child-stub',namespace:'test'}))
   b.onLoad({filter:/^child-stub$/,namespace:'test'},()=>({contents:'export function FilesPanel(){return null};export function GitPanel(){return null}'}))
  }}],
 })
 const {Workbench}=require(outfile)
 globalThis.window={addEventListener(){},removeEventListener(){}}
 globalThis.document={addEventListener(){},removeEventListener(){}}
 globalThis.ResizeObserver=class {observe(){} disconnect(){}}
 t.after(()=>{globalThis.window=previousWindow;globalThis.document=previousDocument;delete require.cache[outfile]})
 const locale={getSnapshot:()=>({active:'en'}),subscribe:()=>()=>{}}
 let renderer
 const reads=[]
 globalThis.__historyTestRpc = null
 const rpc=async(method,params={})=>{
  if(method==='bootstrap') return boot
  if(method==='term.read'){reads.push(params);return{data:'Model reply before the fullscreen TUI: REVIEWABLE_OUTPUT\r\nsecond model line',nextOffset:42,hasMore:false}}
  if(method==='term.list')return{terminals:[session]}
  if(method==='host.test')return{latencyMs:1}
  if(method==='git.info')return{isRepo:false,entries:[]}
  if(method==='forward.list')return{forwards:[]}
  if(method==='harness.list')return{harnesses:[],env:{}}
  return{}
 }
 globalThis.__historyTestRpc=rpc
 await act(async()=>{
  renderer=TestRenderer.create(React.createElement(Workbench,{ctx:{locale}}),{
   createNodeMock(element){
    if (element.type==='canvas') return {getContext(){return{}},width:1000,height:400}
    return {clientWidth:600,clientHeight:400,appendChild(){},querySelector(){return null},getBoundingClientRect(){return{left:0,width:600}},addEventListener(){},removeEventListener(){}}
   },
  })
 })
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25))})
 assert(text(renderer.toJSON()).includes(session.title),'workbench mounted actual terminal title; page: '+text(renderer.toJSON())+' read calls '+JSON.stringify(reads))
 const liveTerminal = renderer.root.find(node => node.type?.name === 'TerminalView')
  assert.equal(liveTerminal.props.onReviewHistory, undefined, 'wheel cannot open the history modal')
  assert.equal(renderer.root.findAllByProps({role:'log'}).length, 0, 'history starts closed')
  const history=renderer.root.findAllByType('button').find(node=>node.props.title==='Session history')
 assert(history,'visible history entry beside session tabs')
 await act(async()=>history.props.onClick())
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})
 assert(text(renderer.toJSON()).includes('REVIEWABLE_OUTPUT'),'clicking the real panel exposes retained model response')
 const log=renderer.root.findByProps({role:'log'})
 assert(log,'scrollable log region present')
 assert(callsHistoryRead(reads),'history reads current session bytes')
 await act(async()=>renderer.unmount())
})
function callsHistoryRead(reads){return reads.some(params=>params.id==='t-abc000abc000')}
