import path from 'node:path';
import {resolveExecutable} from './process.js';

export async function resolveGitExecutable():Promise<string>{
  const candidates=process.platform==='win32'?
    [process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter((base):base is string=>!!base).map(base=>path.join(base,'Git','cmd','git.exe')):[];
  if(process.platform==='win32'&&process.env.LOCALAPPDATA)candidates.push(path.join(process.env.LOCALAPPDATA,'Programs','Git','cmd','git.exe'));
  // Windows Git must remain a native executable: never route policy commands
  // through a batch launcher or a shell merely because it appears on PATH.
  const executable=await resolveExecutable(undefined,[process.platform==='win32'?'git.exe':'git'],candidates);
  if(!executable)throw Error('Git executable not found; install Git or add its executable directory to PATH');
  return executable;
}

// Parse argv, never execute a shell. Metacharacters are deliberately unsupported.
export function gitTokens(command: string): string[] {
  if (/[\r\n\0;&|<>`$]/.test(command)) throw Error('Shell operators are not allowed');
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) throw Error('Unclosed command quote');
  if (started) tokens.push(token);
  return tokens;
}

const flags = new Set(['--oneline','--stat','--shortstat','--numstat','--name-only','--name-status','--summary','--check','--patch','-p','--no-patch','-s','--raw','--binary','--cached','--staged','--compact-summary','--short','--branch','-b','--porcelain','--porcelain=v1','--porcelain=v2','--untracked-files=no','--untracked-files=normal','--untracked-files=all','--ignored','--graph','--decorate','--no-decorate','--all','--first-parent','--no-merges','--merges','--reverse','--date-order','--topo-order','--follow','--find-renames','-M','--find-copies','-C','--no-renames','--no-color','--color=never','--no-ext-diff','--no-textconv','--exit-code','--quiet','--abbrev-commit','--no-abbrev-commit']);
const valueFlags = new Set(['-n','--max-count','--skip','--since','--until','--after','--before','--author','--committer','--grep','--format','--pretty','--date','--diff-filter','--unified','-U','--abbrev']);
const exclusions = ['.env','.env.*','.ssh','.aws','.azure','credentials','credentials.*','secret','secrets','secret.*','secrets.*','id_rsa','id_ed25519'];
function sensitive(value:string) {
  return value.split(/[\\/:]/).some(p=>/^(\.env(?:\..*)?|\.ssh|\.aws|\.azure|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(p));
}
export async function gitReadCommand(command:string, checkPath:(p:string)=>Promise<string>) {
  const tokens=gitTokens(command);
  if(tokens.some(t=>/%G[?NSEFKPT]/.test(t)))throw Error('Signature verification is not a read-only terminal operation');
  if (!/^git(?:\.exe)?$/i.test(tokens.shift() ?? '')) return null;
  if (tokens[0]==='--no-pager') tokens.shift();
  const sub=tokens.shift();
  if (!sub || !['show','log','diff','status','rev-parse','branch','ls-files'].includes(sub)) throw Error('Git mutation/global options are not allowed');
  if (sub==='branch' && !(tokens.length===1 && tokens[0]==='--show-current')) throw Error('Only git branch --show-current is allowed');
  if (sub==='rev-parse' && !(tokens.length===1 && ['HEAD','--show-toplevel','--show-prefix','--is-inside-work-tree','--abbrev-ref'].includes(tokens[0])) && !(tokens.length===2 && tokens[0]==='--abbrev-ref' && tokens[1]==='HEAD')) throw Error('Unsupported rev-parse query');
  let paths=false;
  for(let i=0;i<tokens.length;i++) {
    const arg=tokens[i];
    if(arg==='--' && !paths){paths=true;continue;}
    if(paths) { if(arg.startsWith(':') || path.isAbsolute(arg)) throw Error('Only relative literal workspace paths are allowed'); await checkPath(arg); continue; }
    if(sub==='branch'||sub==='rev-parse') continue;
    if(arg.startsWith('-')) {
      if(sub==='ls-files' && !['--stage','-s','--cached','--error-unmatch'].includes(arg)) throw Error('Unsupported ls-files option');
      if(sub==='ls-files') continue;
      if(flags.has(arg))continue;
      const eq=arg.indexOf('=');
      if(eq>0 && valueFlags.has(arg.slice(0,eq))) continue;
      if(/^-(?:n|U)?\d+$/.test(arg))continue;
      if(valueFlags.has(arg)) {if(!tokens[++i] || tokens[i].startsWith('-'))throw Error('Missing Git option value');continue;}
      throw Error('Unsupported Git read option: '+arg);
    }
    if(sensitive(arg))throw Error('Credential paths are not exposed to the agent');
    const colon=arg.indexOf(':');
    if(colon>=0) {const file=arg.slice(colon+1); if(!file || file.startsWith(':'))throw Error('Unsupported Git object path'); await checkPath(file);}
    else if(arg.includes('/') && !/^(?:refs|origin)\//.test(arg)) await checkPath(arg);
  }
  const args=['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','color.ui=false','-c','log.showSignature=false',sub];
  if(['show','log','diff'].includes(sub))args.push('--no-ext-diff','--no-textconv');
  args.push(...tokens);
  if(['show','log','diff','status','ls-files'].includes(sub)) {
    if(!paths)args.push('--','.');
    for(const name of exclusions)args.push(':(glob,exclude)**/'+name,':(glob,exclude)**/'+name+'/**');
  }
  return {command:await resolveGitExecutable(),args};
}
