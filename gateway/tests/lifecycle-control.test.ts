import test from 'node:test';
import assert from 'node:assert/strict';
import {LifecycleController, type TimerDriver} from '../src/lifecycle.js';

class ManualTimer implements TimerDriver {
  private value=0;
  private next=0;
  private readonly entries=new Map<number,{at:number;callback:()=>void}>();
  now():number{return this.value;}
  setTimeout(callback:()=>void,delayMs:number):number{const id=++this.next;this.entries.set(id,{at:this.value+delayMs,callback});return id;}
  clearTimeout(handle:unknown):void{this.entries.delete(handle as number);}
  advance(ms:number):void{
    const target=this.value+ms;
    for(;;){
      const next=[...this.entries.entries()].filter(([,entry])=>entry.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      this.entries.delete(next[0]);this.value=next[1].at;next[1].callback();
    }
    this.value=target;
  }
}

test('activity never resets the 120-minute task deadline and idle has no separate kill timer',()=>{
  const timer=new ManualTimer();let stopped:string|undefined;
  const control=new LifecycleController({deadlineMs:7_200_000,graceMs:30_000,timer,onCancel:kind=>{stopped=kind;}});
  control.startDeadline();
  // Cross the former fixed ten-minute cutoff both while active and while idle.
  timer.advance(600_001);control.recordActivity();
  assert.equal(control.reason,undefined);
  // An idle task also remains alive until the same overall deadline.
  timer.advance(6_599_998);assert.equal(control.reason,undefined);
  timer.advance(1);
  assert.equal(stopped,'deadline_exceeded');
  assert.equal(control.reason,'deadline_exceeded');
});

test('cancellation asks gracefully once then force-escalates once after the grace window',()=>{
  const timer=new ManualTimer();let graceful=0,forced=0;
  const control=new LifecycleController({deadlineMs:120_000,graceMs:30_000,timer,onCancel:()=>{graceful++;},onForce:()=>{forced++;}});
  control.requestStop('cancelled');
  assert.equal(graceful,1);assert.equal(forced,0);assert.equal(control.reason,'cancelled');
  timer.advance(29_999);assert.equal(forced,0);
  timer.advance(1);assert.equal(forced,1);assert.equal(control.forced,true);
  timer.advance(60_000);assert.equal(graceful,1);assert.equal(forced,1);
});

test('graceful completion cancels force escalation and caller abort uses cancelled classification',()=>{
  const timer=new ManualTimer();const caller=new AbortController();let graceful=0,forced=0;
  const control=new LifecycleController({deadlineMs:120_000,graceMs:30_000,timer,onCancel:()=>{graceful++;},onForce:()=>{forced++;}});
  control.attach(caller.signal);caller.abort();
  assert.equal(control.reason,'cancelled');assert.equal(graceful,1);
  control.complete();timer.advance(60_000);
  assert.equal(forced,0);
  control.dispose(caller.signal);
});

test('deadline is classified distinctly from caller cancellation',()=>{
  const timer=new ManualTimer();let kind:string|undefined;
  const control=new LifecycleController({deadlineMs:1,graceMs:1,timer,onCancel:value=>{kind=value;}});
  control.startDeadline();timer.advance(1);
  assert.equal(kind,'deadline_exceeded');
  assert.equal(control.reason,'deadline_exceeded');
});
