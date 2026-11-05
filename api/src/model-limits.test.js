import test from 'node:test'
import assert from 'node:assert/strict'
import { documentLimits as limits, parseYaml, stringify, validateBlock, validateProject } from './model.js'
import { createBlockService } from './blocks/service.js'
import { createProjectService } from './projects/service.js'
import { replaceEmbeddedImages } from './images.js'
const port = i => ({ id:'p'+i,label:'P',protocol:'IO',direction:'bidirectional' })
const block = (ports=1) => ({ name:'Fixture',function:'Measure',ports:Array.from({length:ports},(_,i)=>port(i)) })
const node = (i,ports=1) => ({ id:'n'+i,position:{x:i,y:0},block:block(ports) })
const project = (nodes=1) => ({name:'Fixture',nodes:Array.from({length:nodes},(_,i)=>node(i)),edges:[]})

test('YAML budgets count UTF-8 bytes and reject deep, cyclic or oversized value graphs', () => {
  assert.equal(parseYaml('#'+'x'.repeat(limits.yamlBytes-1)),null)
  assert.throws(()=>parseYaml('#'+'x'.repeat(limits.yamlBytes)),{status:400})
  const unicode='name: '+ 'é'.repeat(1_000_000)
  assert.ok(unicode.length<limits.yamlBytes);assert.throws(()=>parseYaml(unicode),{status:400})
  assert.throws(()=>parseYaml('['.repeat(limits.depth+2)+'0'+']'.repeat(limits.depth+2)),{status:400})
  assert.throws(()=>parseYaml('value: &cycle {next: *cycle}'),{status:400})
  assert.throws(()=>parseYaml('['+Array(limits.values+1).fill('0').join(',')+']'),{status:400})
  const anchored=parseYaml('one: &one { value: 1 }\ntwo: *one\n');assert.equal(anchored.two.value,1)
  assert.throws(()=>parseYaml('one: &one '+ 'x'.repeat(1_100_000)+'\ntwo: *one\n'),/Expanded YAML/)
})
test('project/block budgets accept exact boundaries and reject before per-element work', () => {
  assert.equal(validateBlock(stringify(block(limits.portsPerBlock))).ports.length,limits.portsPerBlock)
  assert.throws(()=>validateBlock(stringify(block(limits.portsPerBlock+1))),/Ports per block/)
  assert.equal(validateProject(stringify(project(limits.nodes))).nodes.length,limits.nodes)
  assert.throws(()=>validateProject(stringify(project(limits.nodes+1))),/Blocks per project/)
  const wired=project(2)
  wired.edges=Array.from({length:limits.edges},(_,i)=>({id:'e'+i,source:'n0',sourcePort:'p0',target:'n1',targetPort:'p0'}))
  assert.equal(validateProject(stringify(wired)).edges.length,limits.edges)
  wired.edges.push({...wired.edges[0],id:'extra'});assert.throws(()=>validateProject(stringify(wired)),/Connections per project/)
  const manyPorts={name:'Fixture',nodes:Array.from({length:100},(_,i)=>node(i,100)),edges:[]}
  assert.equal(validateProject(stringify(manyPorts)).nodes.length,100)
  manyPorts.nodes[0].block.ports.push(port(101));assert.throws(()=>validateProject(stringify(manyPorts)),/Ports per project/)
})
test('over-budget creation fails before transactions, category queries, image work or writes', async () => {
  const unexpected=()=>{throw Error('Unexpected persistence or image work')},user={id:'fixture-user',role:'dev'}
  const projects=createProjectService({transaction:unexpected,projects:{create:unexpected},attachImages:unexpected})
  await assert.rejects(projects.create(user,{yaml:stringify(project(limits.nodes+1))}),{status:400})
  const blocks=createBlockService({transaction:unexpected,validateCategory:unexpected,blocks:{create:unexpected},attachImages:unexpected})
  await assert.rejects(blocks.create(user,{yaml:stringify(block(limits.portsPerBlock+1))}),{status:400})
  const old=project(limits.nodes+1)
  old.nodes[0].block.image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='
  await assert.rejects(replaceEmbeddedImages(stringify(old),'project',unexpected),{status:400})
})
