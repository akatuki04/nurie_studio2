/* AI support and optional AI background removal for coloring pages.
 * Runs in a module Web Worker. Photo bytes stay in this browser.
 * Models/JS/WASM are fetched on demand; inference runs on-device.
 */
'use strict';
self.onmessage = async (event) => {
  const {type, pixels, width, height, target} = event.data || {};
  if (type !== 'segment' && type !== 'removeBg') return;
  const heartbeat = setInterval(() => self.postMessage({type:'alive'}), 1200);
  try {
    self.postMessage({type:'stage',text:'AIライブラリを読み込んでいます',indeterminate:true});
    const {pipeline, RawImage} = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
    const background = type === 'removeBg';
    const modelId = background ? (target === 'person' ? 'Xenova/modnet' : 'onnx-community/ormbg-ONNX') : 'Xenova/segformer-b0-finetuned-ade-512-512';
    const onProgress = info => {
      if (info.status === 'progress_total' && Number.isFinite(info.progress)) {
        self.postMessage({type:'modelProgress',progress:info.progress});
      } else if (info.status === 'progress' && Number.isFinite(info.progress)) {
        self.postMessage({type:'fileProgress',progress:info.progress,file:info.file});
      } else if(info.status === 'ready') {
        self.postMessage({type:'stage',text:'AIモデルの準備ができました',indeterminate:false});
      }
    };
    const segmenter = await pipeline(background ? 'background-removal' : 'image-segmentation', modelId, {
      device:'wasm', dtype:'q8', progress_callback:onProgress
    });
    const input = new RawImage(new Uint8ClampedArray(pixels), width, height, 4);
    self.postMessage({type:'stage',text:background?'AIが被写体と背景を識別しています（推論中）':'AIが物の境界を解析しています（推論中）',indeterminate:true});
    const outputs = await segmenter(input);
    if (background) {
      // The background-removal pipeline returns a RawImage with its alpha
      // channel representing the retained foreground. We transfer only alpha.
      const result = Array.isArray(outputs) ? outputs[0] : outputs;
      if (!result || !result.width || !result.height || !result.data || result.channels !== 4)
        throw Error('AIから背景削除用の透明度データを取得できませんでした');
      const mask = new Uint8Array(result.width * result.height);
      let count=0;
      for (let i=0;i<mask.length;i++) {
        const alpha = result.data[i*4+3];
        mask[i] = alpha;
        if(alpha >= 112) count++;
      }
      const coverage=count/mask.length;
      if(coverage < 0.004 || coverage > 0.985)
        throw Error('被写体をうまく切り抜けませんでした。被写体がはっきり写った写真を試してください');
      self.postMessage({type:'backgroundResult',buffer:mask.buffer,width:result.width,height:result.height},[mask.buffer]);
    } else {
      if(!Array.isArray(outputs)||!outputs.length)throw Error('領域を認識できませんでした');
      const first=outputs.find(item=>item.mask?.width&&item.mask?.height);
      if(!first)throw Error('AIから輪郭データを取得できませんでした');
      const mw=first.mask.width,mh=first.mask.height;
      const labels=new Uint16Array(mw*mh);
      let accepted=0;
      for(let j=0;j<outputs.length&&j<200;j++) {
        const {mask}=outputs[j]; if(!mask||mask.width!==mw||mask.height!==mh)continue;
        const d=mask.data,stride=mask.channels||1;
        let count=0;
        for(let i=0;i<mw*mh;i++) if(d[i*stride]>127)count++;
        if(count<mw*mh*.004)continue;
        accepted++;
        for(let i=0;i<mw*mh;i++)if(d[i*stride]>127)labels[i]=accepted;
      }
      if(accepted<2)throw Error('AIで区別できる領域が少なかったため、通常の輪郭処理を使用します');
      self.postMessage({type:'result',buffer:labels.buffer,width:mw,height:mh},[labels.buffer]);
    }
  } catch (error) {
    self.postMessage({type:'error',message:error?.message||String(error)});
  } finally {
    clearInterval(heartbeat);
  }
};
