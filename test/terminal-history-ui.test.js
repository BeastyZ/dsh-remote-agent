const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TestRenderer, {act} from 'react-test-renderer'
import {build} from 'esbuild'
import path from 'node:path'

const require=(await import('node:module')).createRequire(import.meta.url)
const outfile=path.resolve('client-src/.test-history.cjs')

function textOf(node) {
  if(node===null || node===undefined) return ''
  if(Array.isArray(node)) return node.map(textOf).join(' ')
  if(typeof node==='string') return node
  return textOf(node.children)
}

test('mounted terminal history really reads, scrolls, restores and closes without sending input',async t=>{
 await build({
  stdin:{contents:`
    import React from 'react';
    import { setReact, setLocale } from './client-src/runtime.js';
    import { setReactDOM } from './client-src/ui.jsx';
    import './client-src/i18n.js';
    setReact(React); setReactDOM(null); setLocale('en');
    export { TerminalHistory } from './client-src/TerminalView.jsx';
  `,resolveDir:path.resolve('.'),loader:'jsx'},
  bundle:true,outfile,platform:'node',format:'cjs',external:['react'],
  jsxFactory:'React.createElement',
  plugins:[{name:'mock-only-live-xterm',setup(bundle){
   // Do not stub @xterm/headless: this test runs the same readable projection
   // used by TerminalHistory, not a synthetic success answer.
   bundle.onResolve({filter:/^@xterm\/(xterm|addon-)/},()=>({path:'unused-live-xterm',namespace:'test'}))
   bundle.onLoad({filter:/^unused-live-xterm$/,namespace:'test'},()=>({contents:'export const Terminal=function(){};export const FitAddon=function(){};export const CanvasAddon=function(){};'}))
  }}],
 })
 const {TerminalHistory}=require(outfile)
 const scroller={scrollHeight:600,scrollTop:0,scrollTo({top}){this.scrollTop=top}}
 const calls=[]
 const rpc=async(method,params)=>{
  calls.push({method,params})
  return{data:'Model answer A\r\nModel answer B\r\n',nextOffset:31,hasMore:false}
 }
 let closed=false
 const options=()=>({
  session:{id:'test-isolated-scroll-session',title:'Model test'},
  rpc,onClose:()=>{closed=true},
 })
 let renderer
 await act(async()=>{
  renderer=TestRenderer.create(React.createElement(TerminalHistory,{...options()}),{createNodeMock(element){return element.props.role==='log'?scroller:null}})
 })
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})
 assert.equal(textOf(renderer.toJSON()).includes('terminal.top'),false,'en locale applied; actual button labels must be translated')
 assert(textOf(renderer.toJSON()).includes('Model answer B'),'loaded model reply is visible')
 // auto-bottom from content load is the initial reading position.
 scroller.scrollTop=420
 const top=renderer.root.findAllByType('button').find(node=>textOf(node)==='View from beginning')
 assert(top, 'top action exists')
 await act(async()=>{top.props.onClick()})
 assert.equal(scroller.scrollTop,0,'top action scrolls the real div')
 const restore=renderer.root.findAllByType('button').find(node=>textOf(node)==='Return to previous review position')
 assert(restore,'restoring the prior review position is available')
 await act(async()=>{restore.props.onClick()})
 assert.equal(scroller.scrollTop,420,'previous review position restored')
 const latest=renderer.root.findAllByType('button').find(node=>textOf(node)==='Latest output')
 await act(async()=>{latest.props.onClick()})
 assert.equal(scroller.scrollTop,600,'latest action goes to actual content bottom')
 const close=renderer.root.findAllByProps({title:'Back to live terminal'})[0]
 await act(async()=>{close.props.onClick()})
 assert.equal(closed,true)
 assert.equal(calls.length,1)
 assert(calls.every(call=>call.method==='term.read'),'no live input or resize was sent')
 await act(async()=>renderer.unmount())
})

test('native terminal slider and history scrolling styles are explicit',()=>{
 const fs=require('node:fs')
 const css=fs.readFileSync(path.resolve('client-src/style.css'),'utf8')
 assert(css.includes('overflow-y: scroll !important'))
 assert(css.includes('.xterm .xterm-viewport::-webkit-scrollbar-thumb'))
 assert(css.includes('.ra-history-scroll::-webkit-scrollbar-thumb'))
})
