import test from 'node:test';import assert from 'node:assert/strict';import geometry from '../geometry.cjs';
const area={x:0,y:0,width:1920,height:1040};
test('restored offscreen compact bar is clamped to monitor work area',()=>{assert.deepEqual(geometry.barBounds({x:4000,y:-100},area),{x:1460,y:0,width:460,height:52});});
test('popup flips above near bottom and clamps horizontal edge',()=>{const bounds=geometry.detailBounds({x:1360,y:980,width:560,height:58},area,540);assert.ok(bounds.y+452<980);assert.equal(bounds.x,1538);});
test('negative coordinates on left monitor remain valid',()=>{const left={x:-1920,y:0,width:1920,height:1080};assert.equal(geometry.barBounds({x:-1700,y:20},left).x,-1700);});
test('pointer contains respects edges',()=>{assert.equal(geometry.contains(area,{x:0,y:0}),true);assert.equal(geometry.contains(area,{x:1920,y:0}),false);});
test('execution detail grows for quota windows, stays centered and fits short displays',()=>{
  const bar={x:720,y:16,width:460,height:52};
  for(const provider of [{provider:'grok'},{provider:'claude'},{provider:'codex',quota:{windows:[{id:'five_hour'},{id:'seven_day'}]}},{provider:'claude',quota:{windows:[{id:'five_hour'},{id:'seven_day'},{id:'seven_day_fable'}]}}]){
    const height=geometry.detailHeight(provider),normal=geometry.detailBounds(bar,area,bar.width/2,height);
    assert.ok(height>=548&&height<=668);assert.equal(normal.x+normal.width/2,bar.x+bar.width/2);assert.equal(normal.height,height);
    const short=geometry.detailBounds(bar,{...area,height:500},bar.width/2,height);assert.equal(short.height,500);assert.equal(short.y,0);
  }
  assert.equal(geometry.detailHeight({provider:'claude',quota:{windows:[{id:'seven_day_fable'}]}}),geometry.detailHeight({provider:'claude'}));
});
