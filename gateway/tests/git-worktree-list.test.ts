import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeGitPath,parseWorktreePorcelain,readWorktreeRegistrations} from '../src/git-worktree-list.js';

test('Git quoted path parser decodes UTF-8 octal bytes and escaped control characters exactly',()=>{
  assert.equal(decodeGitPath('"/tmp/\\355\\225\\234\\352\\270\\200"'),'/tmp/한글');
  assert.equal(decodeGitPath('"/tmp/a\\nline\\twith\\\\slash\\\"quote"'),'/tmp/a\nline\twith\\slash"quote');
  assert.equal(decodeGitPath('/tmp/unquoted space '),'/tmp/unquoted space ');
  assert.equal(decodeGitPath('"/tmp/한글😀"'),'/tmp/한글😀');
  for(const malformed of ['"/tmp/unterminated','"/tmp/\\q"','"/tmp/\\12"','"/tmp/\\400"','"/tmp/\\000"','"/tmp/\\377"','"/tmp/raw"quote"'])assert.throws(()=>decodeGitPath(malformed));
});
test('old Git registration parser preserves quoted newline path without fabricating records',()=>{
  const blocks=parseWorktreePorcelain('worktree "/tmp/line\\nworktree fake"\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/space path\nHEAD def\ndetached\n\n',false);
  assert.deepEqual(blocks,[['worktree /tmp/line\nworktree fake','HEAD abc','branch refs/heads/main'],['worktree /tmp/space path','HEAD def','detached']]);
  assert.throws(()=>parseWorktreePorcelain('worktree /one\nworktree /two\nbranch refs/heads/main',false),/Malformed/);
  assert.throws(()=>parseWorktreePorcelain('branch refs/heads/main',false),/Malformed/);
});
test('NUL porcelain preserves path bytes without applying C-quote decoding',()=>{
  assert.deepEqual(parseWorktreePorcelain('worktree /tmp/"literal"\nnewline\0HEAD abc\0branch refs/heads/main\0\0',true),[['worktree /tmp/"literal"\nnewline','HEAD abc','branch refs/heads/main']]);
});
test('worktree discovery falls back only for confirmed Git unsupported -z option',async()=>{
  const calls:string[][]=[];
  const result=await readWorktreeRegistrations(async args=>{calls.push(args);if(calls.length===1)throw Object.assign(Error('old Git'),{code:129,stderr:"error: unknown switch `z'\n"});return 'worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n';});
  assert.equal(calls.length,2);assert.deepEqual(calls[1],['-c','core.quotePath=true','worktree','list','--porcelain']);assert.equal(result[0][0],'worktree /tmp/repo');
  for(const failure of [{code:128,stderr:'fatal: not a git repository'},{code:129,stderr:'error: access denied'},{code:'ETIMEDOUT',stderr:"error: unknown switch `z'"}]){
    let attempts=0;await assert.rejects(readWorktreeRegistrations(async()=>{attempts++;throw Object.assign(Error('preserve'),failure);}));assert.equal(attempts,1);
  }
});
