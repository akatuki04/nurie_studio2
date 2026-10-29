'use strict';
const $ = (id)=>document.getElementById(id);
const el={
  drop:$('dropZone'),upload:$('uploadBtn'),camera:$('cameraBtn'),file:$('fileInput'),cameraFile:$('cameraInput'),demo:$('demoBtn'),
  fileInfo:$('fileInfo'),source:$('sourceCanvas'),result:$('resultCanvas'),sourceHolder:$('sourcePlaceholder'),resultHolder:$('resultPlaceholder'),
  generate:$('generateBtn'),download:$('downloadBtn'),print:$('printBtn'),quality:$('quality'),thickness:$('thickness'),thicknessValue:$('thicknessValue'),sensitivity:$('sensitivity'),sensitivityValue:$('sensitivityValue'),cleanup:$('cleanup'),cleanupValue:$('cleanupValue'),
  ai:$('aiToggle'),hint:$('deviceHint'),status:$('resultStatus'),progressBox:$('progressBox'),progressTitle:$('progressTitle'),
  progressPercent:$('progressPercent'),progressTrack:$('progressTrack'),progressFill:$('progressFill'),progressDescription:$('progressDescription'),
  cancel:$('cancelBtn'),heartbeat:$('heartbeat'),message:$('message'),printImage:$('printImage')
};
let activeFile=null,sourceReady=false,style='balanced',busy=false,requestId=0;
let outlineWorker=null,aiWorker=null,heartbeatInterval=null,lastSignal=0;
let sourceMax=0,sourceIsSample=false,progressFloor=0;
const mobile = matchMedia('(pointer:coarse)').matches || window.innerWidth<700;
const memory = navigator.deviceMemory || (mobile?3:8);
const cores = navigator.hardwareConcurrency || (mobile?4:8);
const allowedMax = memory<=2?900:memory<=4?1400:2000;
const qualityLimit=()=>{
  const q=el.quality.value;
  let raw=q==='light'?760:q==='standard'?1200:q==='high'?1800:memory<=2?800:memory<=4?1080:mobile?1350:1600;
  return Math.min(raw,allowedMax);
};
function refreshHint(){
  const limit=qualityLimit();
  const msg=el.quality.value==='auto'?'端末の推定性能に合わせて自動調整':
    (limit<(el.quality.value==='high'?1800:el.quality.value==='standard'?1200:760)?'メモリ節約のため上限を調整':'選択した画質で処理');
  el.hint.textContent=`${msg}・最大長辺 ${limit.toLocaleString('ja-JP')} px`;
}
refreshHint();
el.quality.addEventListener('change',()=>{refreshHint();invalidate();});
// Leave AI off on low-memory/mobile devices; users can enable it when needed.
el.ai.checked = false; // keep the fast, faithful local extractor as the default
el.thickness.addEventListener('input',()=>{
  const v=+el.thickness.value;
  el.thicknessValue.textContent=({1:'細め',2:'ふつう',3:'太め',4:'かなり太め'})[v];
  invalidate();
});
el.ai.addEventListener('change',invalidate);
for(const [slider,display] of [[el.sensitivity,el.sensitivityValue],[el.cleanup,el.cleanupValue]]){
  slider.addEventListener('input',()=>{
    display.textContent=['','かなり弱い','弱い','標準','強い','かなり強い'][+slider.value];
    invalidate();
  });
}
document.querySelectorAll('[data-style]').forEach(b=>b.addEventListener('click',()=>{
  style=b.dataset.style;
  document.querySelectorAll('[data-style]').forEach(node=>{
    const selected=node===b;node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));
  });
  invalidate();
}));
function invalidate(){
  if(busy)return;
  el.download.disabled=true;el.print.disabled=true;
  el.result.hidden=true;el.resultHolder.hidden=false;
  if(sourceReady){setStatus('再生成できます');showMessage('',false);}
}
function showMessage(text,error=false){el.message.hidden=!text;el.message.textContent=text;el.message.classList.toggle('error',error);}
function setStatus(text,type=''){el.status.textContent=text;el.status.className='status-pill '+type;}
function setBusy(v){busy=v;el.generate.disabled=v||!sourceReady;el.demo.disabled=v;el.file.disabled=v;el.cameraFile.disabled=v;el.quality.disabled=v;el.ai.disabled=v;el.thickness.disabled=v;el.sensitivity.disabled=v;el.cleanup.disabled=v;document.querySelectorAll('[data-style]').forEach(x=>x.disabled=v);}
function stopWorkers(){
  if(outlineWorker){outlineWorker.terminate();outlineWorker=null;}
  if(aiWorker){aiWorker.terminate();aiWorker=null;}
  if(heartbeatInterval){clearInterval(heartbeatInterval);heartbeatInterval=null;}
}
function beginProgress(){
  el.progressBox.hidden=false;lastSignal=Date.now();progressFloor=0;
  heartbeatInterval=setInterval(()=>{
    const age=Math.floor((Date.now()-lastSignal)/1000);
    el.heartbeat.textContent=age>12?'最終応答から '+age+' 秒：AI推論中は応答間隔が長くなることがあります':'動作確認：最終応答 '+age+' 秒前';
  },1000);
  setProgress(0,'変換を準備しています','画像を準備しています');
}
function pulse(){lastSignal=Date.now();}
function setProgress(pct,title,description,indeterminate=false){
  pct=Math.max(0,Math.min(100,Math.round(pct)));
  progressFloor=Math.max(progressFloor,pct);pct=progressFloor;
  el.progressPercent.textContent=pct+'%';el.progressFill.style.width=pct+'%';el.progressTrack.setAttribute('aria-valuenow',String(pct));
  el.progressTitle.textContent=title;el.progressDescription.textContent=description;
  el.progressTrack.classList.toggle('indeterminate',indeterminate);
  pulse();
}
function cleanupProgress(){el.progressTrack.classList.remove('indeterminate');stopWorkers();setBusy(false);}
function endCancelled(){requestId++;cleanupProgress();el.progressBox.hidden=true;setStatus('キャンセルしました');showMessage('処理を中止しました。設定を変更して、もう一度試せます。');}
el.cancel.addEventListener('click',endCancelled);

// File selector, mobile camera and drag & drop.
el.upload.addEventListener('click',(e)=>{e.stopPropagation();el.file.click();});
el.camera.addEventListener('click',(e)=>{e.stopPropagation();el.cameraFile.click();});
el.drop.addEventListener('click',(e)=>{if(!e.target.closest('button'))el.file.click();});
el.drop.addEventListener('keydown',(e)=>{if(e.target===el.drop&&(e.key==='Enter'||e.key===' ')){e.preventDefault();el.file.click();}});
el.file.addEventListener('change',e=>{if(e.target.files?.[0])loadFile(e.target.files[0]);e.target.value='';});
el.cameraFile.addEventListener('change',e=>{if(e.target.files?.[0])loadFile(e.target.files[0]);e.target.value='';});
['dragenter','dragover'].forEach(k=>el.drop.addEventListener(k,e=>{e.preventDefault();if(!busy)el.drop.classList.add('dragover');}));
['dragleave','drop'].forEach(k=>el.drop.addEventListener(k,e=>{e.preventDefault();el.drop.classList.remove('dragover');}));
el.drop.addEventListener('drop',e=>{if(!busy&&e.dataTransfer.files?.[0])loadFile(e.dataTransfer.files[0]);});

// Decoding uses createImageBitmap's resize where supported. EXIF orientation is
// applied by the browser; the full smartphone photo is not retained on canvas.
async function decodeFile(file,maxSide){
  const url=URL.createObjectURL(file);
  let image=null,bitmap=null;
  try{
    image=new Image(); image.decoding='async';
    image.src=url;
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('画像を読み取れません。JPEG・PNG・WebPなどをお試しください。HEICは端末やブラウザによって対応が異なります。'));});
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width*height>140_000_000)throw Error('この画像は大きすぎるため読み取れません。写真を少し小さくしてからお試しください。');
    const scale=Math.min(1,maxSide/Math.max(width,height));
    const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    try{
      if('createImageBitmap' in window && scale<1){
        bitmap=await createImageBitmap(file,{resizeWidth:w,resizeHeight:h,resizeQuality:'high',imageOrientation:'from-image'});
        ctx.drawImage(bitmap,0,0,w,h);
      }else ctx.drawImage(image,0,0,w,h);
    }catch(_){ctx.drawImage(image,0,0,w,h);}
    return {canvas:cv,naturalWidth:width,naturalHeight:height};
  }finally{if(bitmap)bitmap.close();URL.revokeObjectURL(url);if(image)image.src='';}
}
function showSource(canvas,label){
  el.source.width=canvas.width;el.source.height=canvas.height;
  el.source.getContext('2d',{willReadFrequently:true}).drawImage(canvas,0,0);
  el.source.hidden=false;el.sourceHolder.hidden=true;
  sourceReady=true;el.generate.disabled=false;
  el.download.disabled=true;el.print.disabled=true;el.result.hidden=true;el.resultHolder.hidden=false;
  el.fileInfo.hidden=false;el.fileInfo.textContent=label;
  setStatus('変換の準備ができました');showMessage('');
}
async function loadFile(file){
  if(busy)return;
  if(!file.type.startsWith('image/')&&!/\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)){showMessage('画像ファイルを選んでください。',true);return;}
  if(file.size>55*1024*1024){showMessage('55MBを超える画像は読み込みに時間がかかるため、少し小さくしてお試しください。',true);return;}
  const token=++requestId;
  setStatus('写真を読み取り中','busy');setBusy(true);showMessage('');
  try{
    const data=await decodeFile(file,qualityLimit());if(token!==requestId)return;
    activeFile=file;sourceIsSample=false;sourceMax=Math.max(data.canvas.width,data.canvas.height);
    showSource(data.canvas,`${file.name} ・ ${data.naturalWidth} × ${data.naturalHeight} px ・ ${(file.size/1024/1024).toFixed(1)} MB`);
  }catch(error){if(token===requestId){showMessage(error.message||'読み込みに失敗しました',true);setStatus('読み取りに失敗');}}
  finally{if(token===requestId)setBusy(false);}
}

// Built-in demo scene so the app can be tried without a personal photo.
function makeDemo(){
  const c=document.createElement('canvas');c.width=1200;c.height=840;
  const ctx=c.getContext('2d'),W=c.width,H=c.height;
  const sky=ctx.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#b7dae1');sky.addColorStop(.7,'#e9e5ca');sky.addColorStop(1,'#c4d7a1');ctx.fillStyle=sky;ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#f2cf8e';ctx.beginPath();ctx.arc(920,167,91,0,Math.PI*2);ctx.fill();
  function cloud(x,y,s){ctx.fillStyle='#f1f0df';[[-70,5,43],[-12,-16,55],[57,0,42]].forEach(([cx,cy,r])=>{ctx.beginPath();ctx.ellipse(x+cx*s,y+cy*s,r*s,r*.62*s,0,0,Math.PI*2);ctx.fill();});}
  cloud(258,154,1.4);cloud(735,112,.65);
  ctx.fillStyle='#9cb4a5';ctx.beginPath();ctx.moveTo(0,476);ctx.bezierCurveTo(250,260,365,412,535,435);ctx.bezierCurveTo(730,300,900,365,1200,437);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
  ctx.fillStyle='#709887';ctx.beginPath();ctx.moveTo(0,587);ctx.quadraticCurveTo(322,390,582,570);ctx.quadraticCurveTo(840,405,1200,539);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
  ctx.fillStyle='#a4bc85';ctx.beginPath();ctx.moveTo(0,660);ctx.quadraticCurveTo(340,592,580,659);ctx.quadraticCurveTo(937,575,1200,636);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
  // House and windows, colors designed to produce recognizable simplified line art.
  ctx.fillStyle='#ebd7b3';ctx.fillRect(392,412,414,264);
  ctx.fillStyle='#a76c55';ctx.beginPath();ctx.moveTo(348,421);ctx.lineTo(598,257);ctx.lineTo(857,421);ctx.closePath();ctx.fill();
  ctx.fillStyle='#805c4b';ctx.fillRect(568,522,100,154);
  ctx.fillStyle='#c6e1db';ctx.fillRect(425,476,97,90);ctx.fillRect(691,476,83,90);
  ctx.strokeStyle='#fff4db';ctx.lineWidth=10;ctx.strokeRect(425,476,97,90);ctx.strokeRect(691,476,83,90);
  ctx.beginPath();ctx.moveTo(472,480);ctx.lineTo(472,563);ctx.moveTo(733,480);ctx.lineTo(733,563);ctx.stroke();
  ctx.fillStyle='#d6be89';ctx.beginPath();ctx.moveTo(590,675);ctx.lineTo(690,675);ctx.lineTo(807,840);ctx.lineTo(448,840);ctx.fill();
  function tree(x,y,scale){ctx.fillStyle='#7d6243';ctx.fillRect(x-13*scale,y,26*scale,145*scale);ctx.fillStyle='#537c5e';for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(x+((i%2)?-17:15)*scale,y-34*scale-i*23*scale,(64-i*8)*scale,0,Math.PI*2);ctx.fill();}}
  tree(190,524,1.22);tree(1015,532,1.07);
  for(let i=0;i<80;i++){const x=(i*173+31)%W,y=680+(i*71)%152;ctx.strokeStyle=i%2?'#729761':'#d4bd8a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-3,y-8-(i%10));ctx.stroke();}
  return c;
}
el.demo.addEventListener('click',()=>{
  if(busy)return;
  activeFile=null;sourceIsSample=true;const canvas=makeDemo();sourceMax=1200;
  showSource(canvas,'サンプル画像 ・ 1200 × 840 px');
});

function workCanvas(maxSide){
  const src=el.source;
  const factor=Math.min(1,maxSide/Math.max(src.width,src.height));
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(src.width*factor));c.height=Math.max(1,Math.round(src.height*factor));
  const context=c.getContext('2d',{willReadFrequently:true});context.imageSmoothingQuality='high';context.drawImage(src,0,0,c.width,c.height);return c;
}
async function prepareWorkCanvas(){
  const target=qualityLimit();
  if(activeFile&&target>sourceMax+15){const data=await decodeFile(activeFile,target);return data.canvas;}
  return workCanvas(target);
}
function spawnOutline(c,aiData,token){
  if(token!==requestId)return;
  outlineWorker=new Worker('./outline-worker.js');
  const context=c.getContext('2d',{willReadFrequently:true});const img=context.getImageData(0,0,c.width,c.height);
  const aiEnabled=!!aiData;
  const initial=aiEnabled?48:18,span=aiEnabled?50:80;
  outlineWorker.onmessage=e=>{
    if(token!==requestId)return;pulse();const msg=e.data;
    if(msg.type==='progress')setProgress(initial+span*msg.percent/100,'線画を生成しています',msg.text);
    if(msg.type==='error')failProcessing(msg.message);
    if(msg.type==='result'){
      const result=new ImageData(new Uint8ClampedArray(msg.buffer),msg.width,msg.height);
      el.result.width=msg.width;el.result.height=msg.height;
      el.result.getContext('2d').putImageData(result,0,0);
      el.result.hidden=false;el.resultHolder.hidden=true;
      setProgress(100,'完成しました！','画像の生成が終了しました');
      cleanupProgress();setStatus('完成しました','ready');
      el.download.disabled=false;el.print.disabled=false;
      setTimeout(()=>{if(token===requestId)el.progressBox.hidden=true;},950);
    }
  };
  outlineWorker.onerror=e=>{if(token===requestId)failProcessing('処理用のプログラムを読み込めませんでした。Webサーバーから起動してください。');};
  const message={type:'process',pixels:img.data.buffer,width:c.width,height:c.height,style,thickness:Number(el.thickness.value),sensitivity:Number(el.sensitivity.value),cleanup:Number(el.cleanup.value)};
  const transferred=[img.data.buffer];
  if(aiEnabled){message.aiLabels=aiData.buffer;message.aiWidth=aiData.width;message.aiHeight=aiData.height;transferred.push(aiData.buffer);}
  outlineWorker.postMessage(message,transferred);
}
function failProcessing(text){cleanupProgress();el.progressBox.hidden=true;setStatus('処理できませんでした');showMessage(text||'線画の生成に失敗しました。軽量モードで再度お試しください。',true);}
function beginAI(c,token){
  const maxSide=memory<=4?320:448;
  const factor=Math.min(1,maxSide/Math.max(c.width,c.height));
  const w=Math.max(1,Math.round(c.width*factor)),h=Math.max(1,Math.round(c.height*factor));
  const resized=document.createElement('canvas');resized.width=w;resized.height=h;
  const context=resized.getContext('2d',{willReadFrequently:true});context.drawImage(c,0,0,w,h);
  const pixels=context.getImageData(0,0,w,h).data;
  aiWorker=new Worker('./ai-worker.js',{type:'module'});
  let aiFailed=false;
  const fallback=(reason)=>{
    if(aiFailed||token!==requestId)return;aiFailed=true;
    aiWorker?.terminate();aiWorker=null;
    showMessage('AI補助を利用できなかったため、通常の線画処理に切り替えました。'+(reason?'（'+reason+'）':''));
    setProgress(18,'通常モードで生成します','AIを使わず線画を作成します');
    spawnOutline(c,null,token);
  };
  aiWorker.onerror=()=>fallback('AIの読み込みに失敗');
  aiWorker.onmessage=e=>{
    if(token!==requestId||aiFailed)return;pulse();const msg=e.data;
    if(msg.type==='modelProgress')setProgress(16+Math.round(msg.progress*.28),'AIモデルを準備しています','モデルの取得・読み込み '+Math.round(msg.progress)+'%');
    if(msg.type==='fileProgress'){
      // A file percentage is not the total model percentage. Do not fabricate overall progress.
      setProgress(16,'AIモデルを準備しています','必要なAIファイルを取得しています',true);
    }
    if(msg.type==='stage')setProgress(Math.max(16,parseInt(el.progressPercent.textContent,10)||16), 'AIで輪郭を判定中',msg.text,msg.indeterminate);
    if(msg.type==='error')fallback('この写真または端末ではAI補助を使えませんでした');
    if(msg.type==='result'){
      const labels={buffer:msg.buffer,width:msg.width,height:msg.height};
      aiWorker?.terminate();aiWorker=null;
      setProgress(47,'AI解析が完了しました','元写真の形に沿って線画を描いています');
      spawnOutline(c,labels,token);
    }
  };
  aiWorker.postMessage({type:'segment',pixels:pixels.buffer,width:w,height:h},[pixels.buffer]);
}
async function generate(){
  if(busy||!sourceReady)return;
  if(location.protocol==='file:'){showMessage('直接HTMLを開くと線画処理が使えません。起動する.bat、またはGitHub Pagesで開いてください。',true);return;}
  const token=++requestId;
  setBusy(true);showMessage('');el.download.disabled=true;el.print.disabled=true;
  setStatus('変換しています','busy');beginProgress();
  try{
    const c=await prepareWorkCanvas();if(token!==requestId)return;
    setProgress(12,'写真を最適化しました',`${c.width} × ${c.height} px で処理します`);
    if(el.ai.checked)beginAI(c,token);
    else {setProgress(18,'線画を生成しています','輪郭を細くし、影や短い線を減らします');spawnOutline(c,null,token);}
  }catch(error){if(token===requestId)failProcessing(error.message);}
}
el.generate.addEventListener('click',generate);
function download(){
  if(el.result.hidden)return;
  el.result.toBlob(blob=>{
    if(!blob){showMessage('PNGを作成できませんでした。',true);return;}
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='nurie-'+new Date().toISOString().slice(0,10)+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },'image/png');
}
el.download.addEventListener('click',download);
el.print.addEventListener('click',()=>{
  if(el.result.hidden)return;
  el.printImage.src=el.result.toDataURL('image/png');
  window.print();
});

// Installable as a home-screen app on compatible HTTPS browsers.
if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost")){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
