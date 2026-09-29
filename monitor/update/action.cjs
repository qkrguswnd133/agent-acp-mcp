const semver=require('semver');
function updateAction(state){
  const latest=state?.selected?.version,current=state?.installed?.version;
  const available=!!semver.valid(latest)&&(!current||!!semver.valid(current)&&semver.gt(latest,current));
  const active=!!state?.pending||['checking','downloading','preparing','installing'].includes(state?.phase);
  return {available,canStart:available&&!active&&!state?.blocked&&state?.result?.status!=='rollback_failed',active};
}
module.exports={updateAction};
