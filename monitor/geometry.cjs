const clamp=(value,min,max)=>Math.max(min,Math.min(value,Math.max(min,max)));
function barBounds(position,area,width=460,height=52){
  width=Math.min(width,area.width);
  return {x:Math.round(clamp(position?.x??area.x+(area.width-width)/2,area.x,area.x+area.width-width)),y:Math.round(clamp(position?.y??area.y+16,area.y,area.y+area.height-height)),width,height};
}
function detailBounds(bar,area,offset=bar.width/2,requestedHeight=452){
  const width=Math.min(382,area.width),height=Math.min(requestedHeight,area.height);
  let y=bar.y+bar.height+6;
  if(y+height>area.y+area.height)y=bar.y-height-6;
  return {x:Math.round(clamp(bar.x+offset-width/2,area.x,area.x+area.width-width)),y:Math.round(clamp(y,area.y,area.y+area.height-height)),width,height};
}
function contains(bounds,point){return point.x>=bounds.x&&point.x<bounds.x+bounds.width&&point.y>=bounds.y&&point.y<bounds.y+bounds.height;}
module.exports={barBounds,detailBounds,contains};
