import test from 'node:test'
import assert from 'node:assert/strict'
import { replayTranscript, projectTerminal } from '../client-src/terminal-transcript.js'

const normal = Array.from({length: 80}, (_, i) => `Response line ${i + 1}`).join('\r\n') + '\r\n'
test('history retains old model replies across an alternate-screen transition', async () => {
  const text = await projectTerminal(normal + '\x1b[?1049h\x1b[2J\x1b[H│ ready for the next prompt')
  assert(text.includes('Response line 1'))
  assert(text.includes('Response line 80'))
})
test('available alternate screen is shown rather than an empty primary buffer', async () => {
  const text = await projectTerminal('\x1b[?1049h\x1b[2J\x1b[H│ Model response in the last visible screen\r\n│ › ')
  assert(text.includes('Model response'))
})
test('RPC reading terminates after the first data frame without repeating data', async () => {
  const calls=[]
  const result = await replayTranscript(async params=> {
    calls.push(params)
    return {data:normal,nextOffset:normal.length,hasMore:false,exited:false}
  })
  assert.equal(calls.length,1)
  assert(result.text.includes('Response line 80'))
})
test('saved terminal exit text remains directly scrollable', async () => {
  const result = await replayTranscript(async()=>({data:normal,archivedText:true,exited:true}))
  assert.equal(result.archived,true)
  assert(result.text.includes('Response line 1'))
})
