import test from 'node:test'
const previousReactAct = globalThis.IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const previousWindow = globalThis.window
const previousDocument = globalThis.document

import assert from 'node:assert/strict'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const A = {id:'session-A',hostId:'server',workspaceId:'w-alpha',cwd:'/alpha',title:'Kimi Alpha',state:'running'}
const B = {id:'session-B',hostId:'server',workspaceId:'w-beta',cwd:'/beta',title:'Codex Beta',state:'running'}
const workspaceA = {id:'w-alpha',hostId:'server',name:'alpha',path:'/alpha'}
const workspaceB = {id:'w-beta',hostId:'server',name:'beta',path:'/beta'}
const boot = {
  version:'1.0.1',hosts:[{id:'server',name:'Server',detail:'demo'}],
  workspaces:[workspaceA,workspaceB],terminals:[A,B],
  lastHostId:'server',lastWorkspaceId:'w-alpha',
  activeTerminals:{'w-alpha':'session-A','w-beta':'session-B'},warnings:[],settings:{},
}
const calls=[]
async function rpc(method,params={}) {
  calls.push({method,params})
  if(method==='bootstrap') return boot
  if(method==='host.test') return {ok:true,latencyMs:1}
  if(method==='term.list') return {terminals:[A,B]}
  if(method==='harness.list') return {harnesses:[],env:{}}
  if(method==='git.info') return {isRepo:false,entries:[]}
  if(method==='forward.list') return {forwards:[]}
  return {ok:true}
}
function texts(node,output=[]) {
  if (node===null || node===undefined || typeof node === 'boolean') return output
  if(Array.isArray(node)) {node.forEach(child=>texts(child,output));return output}
  if(typeof node === 'string' || typeof node === 'number') output.push(String(node))
  else texts(node.children,output)
  return output
}
async function settle() {
  for(let i=0;i<5;i++)await act(async()=>{await Promise.resolve()})
}

test('WorkBench retains the session of each chosen workspace while switching',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ra-onmounted-'))
  t.after(()=>{if(path.dirname(dir)===os.tmpdir())fs.rmSync(dir,{recursive:true,force:true})})
  const outfile = path.resolve('client-src/.test-suite.cjs')
  await build({
    stdin:{contents:`
      import React from 'react';
      import { Workbench as Loaded } from './client-src/Workbench.jsx'
      import {setReact} from './client-src/runtime.js';
      setReact(React);
      export const Workbench = Loaded;
    `,resolveDir:path.resolve('.'),sourcefile:'entry.jsx',loader:'jsx'},
    bundle:true,outfile,format:'cjs',platform:'node',jsxFactory:'React.createElement',
    external: ['react'],
    plugins:[{name:'test',setup(b){
      b.onResolve({filter:/(TerminalView|FilesPanel|GitPanel)/},()=>({path:'child',namespace:'stub'}))
      b.onLoad({filter:/^child$/,namespace:'stub'},()=>({contents:'export function TerminalView(){return null} export function FilesPanel(){return null} export function GitPanel(){return null}'}))
      b.onResolve({filter:/\/api$/},()=>({path:'api',namespace:'stub'}))
      b.onLoad({filter:/^api$/,namespace:'stub'},()=>({contents:'export function rpc(method,params){return fetch("/rpc",{method:"POST",body:JSON.stringify({method,params})}).then(r=>r.json()).then(v=>v.value)}'}))
    }}],
  })
  const previousFetch=global.fetch
  global.fetch=async (_url,options)=>({json:async()=>({ok:true,value:await rpc(JSON.parse(options.body).method,JSON.parse(options.body).params)})})
  globalThis.window={addEventListener(){},removeEventListener(){}}
  t.after(()=>{
    global.fetch=previousFetch
    globalThis.window=previousWindow
    globalThis.document=previousDocument
    globalThis.IS_REACT_ACT_ENVIRONMENT=previousReactAct
  })
  const {Workbench}=require(outfile)
  const locale={getSnapshot:()=>({active:'en'}),subscribe:()=>()=>{}}
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Workbench,{ctx:{locale}}))
    await Promise.resolve()
  })
  await settle()
  assert(texts(renderer.toJSON()).join(' ').includes('Kimi Alpha'))
  assert(!texts(renderer.toJSON()).join(' ').includes('Codex Beta'))
  const betaRow=renderer.root.findAllByProps({title:'/beta'}).find(node=>node.type==='button')
  assert(betaRow,'non-selected workspace B is visible as a row')
  await act(async()=>{betaRow.props.onClick('w-beta')})
  await settle()
  assert(texts(renderer.toJSON()).join(' ').includes('Codex Beta'))
  assert(!texts(renderer.toJSON()).join(' ').includes('Kimi Alpha'))
  const activeTabs=renderer.root.findAllByProps({className:'ra-tab is-active'})
  assert.equal(activeTabs.length,1)
  assert(activeTabs[0].props.title.startsWith('Codex Beta'), 'matching terminal follows workspace');
  const alphaRow=renderer.root.findAllByProps({title:'/alpha'}).find(node=>node.type==='button')
  assert(alphaRow)
  await act(async()=>{alphaRow.props.onClick('w-alpha')})
  await settle()
  assert(texts(renderer.toJSON()).join(' ').includes('Kimi Alpha'))
  assert(!texts(renderer.toJSON()).join(' ').includes('Codex Beta'))
  await act(async()=>renderer.unmount())
})
