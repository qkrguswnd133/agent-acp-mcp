import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createLoginItem,quoteArg,LABEL}=createRequire(import.meta.url)('../login-item.cjs');
const exe='C:\\Users\\sample\\AppData\\Local\\Programs\\Agent Monitor\\Agent Monitor.exe';
// In-memory stand-in for Electron's Windows login-item API; never touches the registry.
function fakeApi({approved=true,failSet,failGet,ignoreSet}={}){
  const calls={get:[],set:[]};let entry=null;
  return {calls,get entry(){return entry;},set approved(value){approved=value;},api:{
    get(options){calls.get.push(options);if(failGet)throw Error(failGet);const match=entry&&entry.path===options.path.replace(/^"(.*)"$/,'$1')&&entry.args.join(' ')===options.args.join(' ');
      return {openAtLogin:!!match,executableWillLaunchAtLogin:!!entry&&approved,launchItems:entry?[{name:'Agent Monitor',path:entry.path,args:entry.args.map(arg=>arg.replace(/^"(.*)"$/,'$1')),scope:'user',enabled:approved}]:[]};},
    set(settings){calls.set.push(settings);if(failSet)throw Error(failSet);if(ignoreSet)return;entry=settings.openAtLogin?{path:settings.path,args:settings.args}:null;if(settings.openAtLogin&&settings.enabled)approved=true;}
  }};
}
const create=(fake,extra={})=>createLoginItem({loginApi:fake.api,platform:'win32',packaged:true,execPath:exe,...extra});

test('defaults off and reading state never registers anything',()=>{
  const fake=fakeApi(),item=create(fake);
  assert.deepEqual(item.read(),{available:true,registered:false,enabled:false,blocked:false});
  const entry=item.menuItem();assert.equal(entry.label,LABEL);assert.equal(entry.type,'checkbox');assert.equal(entry.checked,false);assert.equal(entry.enabled,true);
  assert.equal(fake.calls.set.length,0);
});
test('development, unpackaged and non-Windows runs are disabled without calling the OS',()=>{
  for(const extra of [{packaged:false},{platform:'darwin'},{execPath:'C:\\dev\\node_modules\\electron\\dist\\electron.exe'}]){
    const fake=fakeApi(),item=create(fake,extra),entry=item.menuItem();
    assert.equal(entry.enabled,false);assert.equal(entry.checked,false);assert.match(entry.label,/\(.+\)$/);
    assert.throws(()=>item.setEnabled(true),/변경할 수 없습니다/);entry.click();
    assert.equal(fake.calls.get.length+fake.calls.set.length,0);
  }
});
test('explicit opt-in registers the installed executable with the configured data directory',()=>{
  const fake=fakeApi(),notices=[],item=create(fake,{dataDir:'D:\\Agent Data\\monitor',notify:message=>notices.push(message)});
  item.menuItem().click();
  assert.deepEqual(fake.calls.set,[{path:exe,args:['"--data-dir=D:\\Agent Data\\monitor"'],openAtLogin:true,enabled:true}]);
  assert.deepEqual(notices,[]);const entry=item.menuItem();assert.equal(entry.checked,true);assert.equal(entry.label,LABEL);
  entry.click();assert.deepEqual(fake.calls.set[1],{path:exe,args:['"--data-dir=D:\\Agent Data\\monitor"'],openAtLogin:false});
  assert.equal(fake.entry,null);assert.equal(item.menuItem().checked,false);
});
test('no data-dir argument is added when none was configured',()=>{
  const fake=fakeApi(),item=create(fake);item.setEnabled(true);assert.deepEqual(fake.calls.set[0].args,[]);
});
test('startup disabled in Windows settings is reported honestly as off',()=>{
  const fake=fakeApi(),item=create(fake);item.setEnabled(true);fake.approved=false;
  const state=item.read();assert.equal(state.registered,true);assert.equal(state.enabled,false);assert.equal(state.blocked,true);
  const entry=item.menuItem();assert.equal(entry.checked,false);assert.match(entry.label,/Windows 시작 앱에서 꺼짐/);
});
test('OS failures surface visible errors and leave state unchanged',()=>{
  const notices=[];
  const failing=fakeApi({failSet:'access denied'});create(failing,{notify:m=>notices.push(m)}).menuItem().click();
  assert.match(notices[0],/access denied/);assert.equal(failing.entry,null);
  const ignored=fakeApi({ignoreSet:true});assert.throws(()=>create(ignored).setEnabled(true),/반영되지 않았습니다/);
  const unreadable=create(fakeApi({failGet:'registry unavailable'})),entry=unreadable.menuItem();
  assert.equal(entry.checked,false);assert.match(entry.label,/상태 확인 실패/);assert.match(unreadable.read().error,/registry unavailable/);
});
test('command-line quoting keeps spaces and trailing backslashes intact',()=>{
  assert.equal(quoteArg('--data-dir=C:\\Data'),'--data-dir=C:\\Data');
  assert.equal(quoteArg('--data-dir=C:\\My Data'),'"--data-dir=C:\\My Data"');
  assert.equal(quoteArg('--data-dir=D:\\'),'"--data-dir=D:\\\\"');
});

test('Electron 44 lookup quotes executable spaces without changing registration path',()=>{
 let registered=false;const calls=[];
 const item=createLoginItem({platform:'win32',packaged:true,execPath:exe,loginApi:{
  set(value){assert.equal(value.path,exe);registered=value.openAtLogin;},
  get(value){calls.push(value);const lookup=value.path===`"${exe}"`;return {openAtLogin:registered,executableWillLaunchAtLogin:registered&&lookup,launchItems:[]};}
 }});
 assert.equal(item.setEnabled(true).enabled,true);
 assert.equal(calls[0].path,`"${exe}"`);
 assert.equal(item.read().blocked,false);
});
