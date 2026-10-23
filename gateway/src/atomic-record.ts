import fs from 'node:fs/promises';

interface ReplaceOptions {
 platform?:NodeJS.Platform;
 rename?:(source:string,destination:string)=>Promise<void>;
 beforeAttempt?:()=>Promise<void>;
 delay?:(milliseconds:number)=>Promise<void>;
}
/** Windows readers/virus scanners can briefly deny an atomic rename. Retry
 * only replacement of the already-written record, never its underlying job.
 * Never unlink the destination: readers must see the old or new complete file. */
export async function replaceRecord(source:string,destination:string,options:ReplaceOptions={}){
 const rename=options.rename??fs.rename,delay=options.delay??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 for(let attempt=0;;attempt++){
  await options.beforeAttempt?.();
  try{await rename(source,destination);return;}
  catch(error){
   if((options.platform??process.platform)!=='win32'||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=7)throw error;
   await delay(Math.min(20*2**attempt,200));
  }
 }
}
