/* Optional AI segmentation. Photo data is processed locally in the browser.
   CDN delivers JavaScript and pretrained model weights only, never the photo. */
let segmenterPromise;
self.onmessage=async(event)=>{
  if(event.data.type!=='segment') return;
  const {pixels,width,height}=event.data;
  const heartbeat=setInterval(()=>self.postMessage({type:'alive'}),1200);
  try{
    self.postMessage({type:'stage',text:'AIライブラリを準備しています',indeterminate:true});
    // Version is pinned for repeatable deployment. Internet needed on first run.
    const {pipeline,RawImage}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
    if(!segmenterPromise){
      segmenterPromise=pipeline('image-segmentation','Xenova/segformer-b0-finetuned-ade-512-512',{
        device:'wasm',dtype:'q8',
        progress_callback:(info)=>{
          if(info.status==='progress_total'&&Number.isFinite(info.progress)){
            self.postMessage({type:'modelProgress',progress:info.progress});
          }else if(info.status==='progress'&&Number.isFinite(info.progress)){
            self.postMessage({type:'fileProgress',progress:info.progress,file:info.file});
          }else if(info.status==='ready'){
            self.postMessage({type:'stage',text:'AIモデルの読み込みが完了しました',indeterminate:false});
          }
        }
      });
    }
    const model=await segmenterPromise;
    self.postMessage({type:'stage',text:'AIが物の境界を解析しています（処理中）',indeterminate:true});
    const image=new RawImage(new Uint8ClampedArray(pixels),width,height,4);
    const results=await model(image);
    if(!Array.isArray(results)||!results.length)throw new Error('画像から物体領域を認識できませんでした');
    const first=results.find(item=>item.mask&&item.mask.width&&item.mask.height);
    if(!first)throw new Error('AIから輪郭データが返されませんでした');
    const mw=first.mask.width,mh=first.mask.height;
    const labels=new Uint16Array(mw*mh);
    let accepted=0;
    for(let j=0;j<results.length&&j<200;j++){
      const {mask}=results[j]; if(!mask||mask.width!==mw||mask.height!==mh)continue;
      const d=mask.data,stride=mask.channels||1;
      let count=0;
      for(let i=0;i<mw*mh;i++)if(d[i*stride]>127)count++;
      if(count<mw*mh*.004)continue;
      accepted++;
      for(let i=0;i<mw*mh;i++)if(d[i*stride]>127)labels[i]=accepted;
    }
    if(accepted<2)throw new Error('AIで区別できる領域が少なかったため、通常の輪郭処理を使用します');
    self.postMessage({type:'result',buffer:labels.buffer,width:mw,height:mh},[labels.buffer]);
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error)});}
  finally{clearInterval(heartbeat);}
};
