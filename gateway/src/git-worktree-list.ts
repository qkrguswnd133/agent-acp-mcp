/** Decode Git's C-quoted pathname without treating octal UTF-8 bytes as Unicode
 * codepoints. Invalid/ambiguous encodings fail closed before any cleanup. */
export function decodeGitPath(value:string):string {
  if(!value.startsWith('"')){if(!value||value.includes('\0')||value.includes('\n')||value.includes('\r'))throw Error('Unsafe worktree pathname');return value;}
  if(!value.endsWith('"')||value.length<2)throw Error('Malformed quoted Git pathname');
  const pieces:Buffer[]=[];
  const escapes:Record<string,string>={a:'\x07',b:'\b',t:'\t',n:'\n',v:'\v',f:'\f',r:'\r','\\':'\\','"':'"'};
  for(let i=1;i<value.length-1;){
    const character=value[i++];
    if(character==='"')throw Error('Ambiguous quoted Git pathname');
    if(character!=='\\'){
      const code=value.codePointAt(i-1)!;pieces.push(Buffer.from(String.fromCodePoint(code)));if(code>0xffff)i++;continue;
    }
    if(i>=value.length-1)throw Error('Truncated quoted Git pathname escape');
    const escaped=value[i++];
    if(Object.hasOwn(escapes,escaped))pieces.push(Buffer.from(escapes[escaped]));
    else if(/[0-7]/.test(escaped)){
      const octal=escaped+value.slice(i,i+2);if(!/^[0-3][0-7]{2}$/.test(octal)||i+2>value.length-1)throw Error('Invalid Git octal pathname escape');
      pieces.push(Buffer.from([parseInt(octal,8)]));i+=2;
    }else throw Error('Unknown Git pathname escape');
  }
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces));
  if(!decoded||decoded.includes('\0'))throw Error('Unsafe decoded Git pathname');
  return decoded;
}

export function parseWorktreePorcelain(text:string,nulDelimited:boolean):string[][] {
  const blocks=nulDelimited?text.split('\0\0'):text.replace(/\r\n/g,'\n').split('\n\n');
  return blocks.filter(block=>block.trim()).map(block=>{
    const lines=block.split(nulDelimited?'\0':'\n').filter(Boolean);
    if(!lines[0]?.startsWith('worktree ')||lines.filter(line=>line.startsWith('worktree ')).length!==1||lines.filter(line=>line.startsWith('branch ')).length>1)throw Error('Malformed Git worktree registration');
    if(nulDelimited){if(!lines[0].slice(9))throw Error('Empty Git worktree path');}
    else lines[0]='worktree '+decodeGitPath(lines[0].slice(9));
    return lines;
  });
}

/** Git 2.25 (Ubuntu 20.04) lacks worktree-list -z. Only its exact unsupported
 * option failure permits the older, rigorously parsed porcelain format. */
export async function readWorktreeRegistrations(run:(args:string[])=>Promise<string>):Promise<string[][]> {
  let raw:string;
  try{raw=await run(['worktree','list','--porcelain','-z']);}
  catch(error){
    const failure=error as {code?:number;stderr?:unknown};
    if(failure.code!==129||!/^error: unknown (?:switch|option) [`'"]z['"`]/m.test(String(failure.stderr??'')))throw error;
    return parseWorktreePorcelain(await run(['-c','core.quotePath=true','worktree','list','--porcelain']),false);
  }
  return parseWorktreePorcelain(raw,true);
}
