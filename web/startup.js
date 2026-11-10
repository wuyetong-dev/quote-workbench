'use strict';
// Start reading the active draft while the browser loads the application scripts.
window.QuoteStartup=(async()=>{
 try{
  let id='';try{id=localStorage.getItem('quote-workbench-last')||'';}catch{}
  const response=await fetch('/api/startup?quoteId='+encodeURIComponent(id));
  if(response.status===404)return {legacy:true};
  if(!response.ok)throw Error('本机报价读取失败');
  return {payload:await response.json()};
 }catch(error){return {error};}
})();
