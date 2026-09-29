export interface AccountStatus {status:'authenticated'|'unauthenticated'|'unknown';email?:string;displayName?:string;organization?:string;source:string;observedAt:string;}
/** Keep only public identity labels from official auth responses, never tokens or IDs. */
export function accountStatus(authenticated:boolean|'unknown',identity:any,source:string,now=Date.now()):AccountStatus{
 const base:AccountStatus={status:authenticated===true?'authenticated':authenticated===false?'unauthenticated':'unknown',source,observedAt:new Date(now).toISOString()};
 if(authenticated!==true)return base;
 const text=(value:unknown)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,256):'';
 for(const key of ['email','displayName','organization'] as const){const value=text(identity?.[key]);if(value)base[key]=value;}
 return base;
}
