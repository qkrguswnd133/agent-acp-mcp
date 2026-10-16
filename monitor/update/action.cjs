const semver=require('semver');
function updateAction(state){
  const latest=state?.selected?.version,current=state?.installed?.version;
  const available=!!semver.valid(latest)&&(!current||!!semver.valid(current)&&semver.gt(latest,current))||state?.wslAvailable===true;
  const active=!!state?.pending||state?.unified?.active===true||state?.otherUpdateBusy===true||['checking','downloading','preparing','installing'].includes(state?.phase);
  return {available,canStart:(available||state?.wslUnchecked===true)&&!active&&!state?.blocked&&state?.result?.status!=='rollback_failed',active};
}
module.exports={updateAction};
