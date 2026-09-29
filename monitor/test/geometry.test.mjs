import test from 'node:test';import assert from 'node:assert/strict';import geometry from '../geometry.cjs';
const area={x:0,y:0,width:1920,height:1040};
test('restored offscreen compact bar is clamped to monitor work area',()=>{assert.deepEqual(geometry.barBounds({x:4000,y:-100},area),{x:1460,y:0,width:460,height:52});});
test('popup flips above near bottom and clamps horizontal edge',()=>{const bounds=geometry.detailBounds({x:1360,y:980,width:560,height:58},area,540);assert.ok(bounds.y+452<980);assert.equal(bounds.x,1538);});
test('negative coordinates on left monitor remain valid',()=>{const left={x:-1920,y:0,width:1920,height:1080};assert.equal(geometry.barBounds({x:-1700,y:20},left).x,-1700);});
test('pointer contains respects edges',()=>{assert.equal(geometry.contains(area,{x:0,y:0}),true);assert.equal(geometry.contains(area,{x:1920,y:0}),false);});
