const assert = require('node:assert/strict')
const test = require('node:test')
const { HealthCache } = require('../dist/src/health-cache.js')
const { setImmediate: tick } = require('node:timers/promises')

function deferred() { let resolve, reject; const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject} }

test('background refresh leaves a still-fresh result fast and shares one in-flight check', async () => {
  let now=0, calls=0, next=Promise.resolve({ready:true})
  const cache=new HealthCache(()=>{calls++;return next},15000,()=>now)
  assert.equal((await cache.get()).ready,true)
  now=10000
  const update=deferred();next=update.promise
  const refreshing=cache.refresh()
  assert.equal(cache.refresh(),refreshing)
  assert.equal((await cache.get()).ready,true)
  update.resolve({ready:false})
  await refreshing
  assert.equal((await cache.get()).ready,false)
  assert.equal(calls,2)
})

test('an expired result cannot hide a slow refresh or failed health check', async () => {
  let now=0,next=Promise.resolve('old')
  const cache=new HealthCache(()=>next,15000,()=>now)
  await cache.get()
  now=10000
  const update=deferred();next=update.promise
  const refreshing=cache.refresh()
  now=15000
  let done=false
  const request=cache.get().then(()=>{done=true})
  await tick();assert.equal(done,false)
  update.resolve('new');await refreshing;await request
  assert.equal(await cache.get(),'new')
  now=30001;next=Promise.reject(new Error('real health failure'))
  await assert.rejects(cache.get(),/real health failure/)
})

test('shutdown awaits the in-flight health check before database disposal', async () => {
  const update=deferred(),cache=new HealthCache(()=>update.promise,15000)
  cache.refresh()
  let drained=false
  const drain=cache.drain().then(()=>{drained=true})
  await tick();assert.equal(drained,false)
  update.resolve('done');await drain
})

test('early refresh covers a bounded API retry without extending freshness or hiding its result', async () => {
  let now=0,next=Promise.resolve({ready:true})
  const cache=new HealthCache(()=>next,15000,()=>now)
  await cache.get()
  now=5000
  const update=deferred();next=update.promise
  const refreshing=cache.refresh()
  for (now=5000;now<=13000;now+=250) assert.equal((await cache.get()).ready,true)
  update.resolve({ready:false});await refreshing
  assert.equal((await cache.get()).ready,false)
})
