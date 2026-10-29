/*
 * ぬりえ工房 v2: photograph-faithful edge extractor.
 * Runs entirely off the main UI thread with no network calls.
 * Edge-preserving (separable bilateral) denoise, Sobel gradient,
 * non-maximum suppression, adaptive double threshold hysteresis,
 * short-stroke cleanup, optional semantic-border guidance.
 * Unlike color quantization, this does NOT change object geometry.
 */
'use strict';
self.onmessage = (event) => {
  if (event.data?.type !== 'process') return;
  try { render(event.data); }
  catch (err) { self.postMessage({type: 'error', message: err?.message || '線画処理に失敗しました'}); }
};
function progress(percent, text) {
  self.postMessage({type:'progress', percent:Math.round(percent), text});
}
function render({pixels, width:w, height:h, style='balanced', thickness=2, sensitivity=3, cleanup=3, aiLabels, aiWidth, aiHeight}) {
  const n=w*h;
  if (w<8||h<8||n>6000000) throw Error('画像のサイズが処理範囲外です');
  const src=new Uint8ClampedArray(pixels);
  const strength=Math.max(1,Math.min(5,Number(sensitivity)||3));
  const noise=Math.max(1,Math.min(5,Number(cleanup)||3));
  const modes={
    simple:{radius:4, sigma:24, percentile:84, minComponent:18},
    balanced:{radius:3, sigma:22, percentile:71, minComponent:12},
    detailed:{radius:2, sigma:19, percentile:55, minComponent:6}
  };
  const conf=modes[style]||modes.balanced;
  // 5 on the noise slider is the most aggressive smoothing.
  const radius=Math.min(6,Math.max(2,conf.radius+Math.round((noise-3)/1.7)));
  const rangeSigma=conf.sigma+(noise-3)*3;
  const grayscale=new Float32Array(n);
  progress(2,'画像の色と明るさを解析しています');
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=y*w+x, j=i*4;
      // Color-aware luminance, without clustering or arbitrary new outlines.
      grayscale[i]=0.299*src[j]+0.587*src[j+1]+0.114*src[j+2];
    }
    if(y%110===0)progress(2+8*y/h,'写真の明暗を解析しています');
  }
  progress(10,'輪郭を残しながらノイズを軽減しています');
  // Separable bilateral, bounded O(N * radius) time and O(N) memory.
  const gaussian=new Float32Array(radius+1);
  for(let d=0;d<=radius;d++)gaussian[d]=Math.exp(-d*d/(2*(radius*.7+0.5)**2));
  const range=new Float32Array(256);
  for(let d=0;d<256;d++)range[d]=Math.exp(-d*d/(2*rangeSigma*rangeSigma));
  const intermediate=new Float32Array(n),smooth=new Float32Array(n);
  for(let y=0;y<h;y++){
    const base=y*w;
    for(let x=0;x<w;x++){
      const center=grayscale[base+x];
      let sum=center, weight=1;
      for(let d=1;d<=radius;d++){
        const a=grayscale[base+Math.max(0,x-d)],b=grayscale[base+Math.min(w-1,x+d)];
        const wa=gaussian[d]*range[Math.min(255,Math.round(Math.abs(a-center)))];
        const wb=gaussian[d]*range[Math.min(255,Math.round(Math.abs(b-center)))];
        sum+=a*wa+b*wb;weight+=wa+wb;
      }
      intermediate[base+x]=sum/weight;
    }
    if(y%50===0)progress(10+15*y/h,'横方向のノイズを整理しています');
  }
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=y*w+x,center=intermediate[i];
      let sum=center, weight=1;
      for(let d=1;d<=radius;d++){
        const a=intermediate[Math.max(0,y-d)*w+x],b=intermediate[Math.min(h-1,y+d)*w+x];
        const wa=gaussian[d]*range[Math.min(255,Math.round(Math.abs(a-center)))];
        const wb=gaussian[d]*range[Math.min(255,Math.round(Math.abs(b-center)))];
        sum+=a*wa+b*wb;weight+=wa+wb;
      }
      smooth[i]=sum/weight;
    }
    if(y%55===0)progress(25+13*y/h,'縦方向のノイズを整理しています');
  }
  progress(39,'写真の輪郭の強さと方向を調べています');
  const mag=new Float32Array(n),direction=new Uint8Array(n);
  for(let y=1;y<h-1;y++){
    const u=(y-1)*w,m=y*w,d=(y+1)*w;
    for(let x=1;x<w-1;x++){
      const gx=(-smooth[u+x-1]+smooth[u+x+1]-2*smooth[m+x-1]+2*smooth[m+x+1]-smooth[d+x-1]+smooth[d+x+1])*.25;
      const gy=(-smooth[u+x-1]-2*smooth[u+x]-smooth[u+x+1]+smooth[d+x-1]+2*smooth[d+x]+smooth[d+x+1])*.25;
      const ax=Math.abs(gx),ay=Math.abs(gy),i=m+x;
      mag[i]=Math.sqrt(gx*gx+gy*gy);
      direction[i]=ay*2<ax?0:(ax*2<ay?2:(gx*gy>=0?1:3));
    }
    if(y%52===0)progress(39+17*y/h,'輪郭の強さと方向を解析しています');
  }
  progress(57,'輪郭を細い線に整えています');
  // Non-maximum suppression thins broad gradients to one-pixel center lines.
  const suppressed=new Float32Array(n), hist=new Uint32Array(256);
  let observations=0;
  for(let y=2;y<h-2;y++){
    for(let x=2;x<w-2;x++){
      const i=y*w+x,v=mag[i];if(v<6)continue;
      let a,b;
      switch(direction[i]){
        case 0:a=i-1;b=i+1;break;
        case 1:a=i-w-1;b=i+w+1;break;
        case 2:a=i-w;b=i+w;break;
        default:a=i-w+1;b=i+w-1;
      }
      if(v>=mag[a]&&v>mag[b]){
        suppressed[i]=v;
        hist[Math.min(255,v|0)]++;
        observations++;
      }
    }
    if(y%54===0)progress(57+9*y/h,'輪郭線の太りを防いでいます');
  }
  // Adaptive threshold based on real image gradient distribution.
  // The sensitivity slider changes the fraction of weak edges retained.
  const percentile=Math.min(96,Math.max(30,conf.percentile-(strength-3)*9));
  let cumulative=0, high=25;
  if(observations){
    const target=observations*percentile/100;
    for(let p=0;p<256;p++){cumulative+=hist[p];if(cumulative>=target){high=p;break;}}
  }
  // Avoid creating a carpet of noise in very low-contrast photos.
  high=Math.max(style==='detailed'?12:18,Math.min(175,high));
  const low=Math.max(5,high*.40);
  progress(68,'意味のある輪郭だけをつないでいます');
  // Hysteresis tracks weak edges only when attached to strong ones.
  const selected=new Uint8Array(n),queue=new Int32Array(n);
  let head=0,tail=0;
  for(let y=2;y<h-2;y++){
    for(let x=2;x<w-2;x++){
      const i=y*w+x;
      if(suppressed[i]>=high){selected[i]=2;queue[tail++]=i;}
      else if(suppressed[i]>=low)selected[i]=1;
    }
    if(y%60===0)progress(68+6*y/h,'強い輪郭を抽出しています');
  }
  const neighbors=[-w-1,-w,-w+1,-1,1,w-1,w,w+1];
  while(head<tail){
    const index=queue[head++],x=index%w;
    for(let k=0;k<8;k++){
      if((x===0&&(k===0||k===3||k===5))||(x===w-1&&(k===2||k===4||k===7)))continue;
      const j=index+neighbors[k];
      if(j>=0&&j<n&&selected[j]===1){selected[j]=2;queue[tail++]=j;}
    }
    if(head%40000===0)progress(74+7*head/Math.max(1,tail),'輪郭を接続しています');
  }
  progress(82,'短いノイズ線を取り除いています');
  // Only connected strokes at least this long survive. Does not
  // relocate meaningful edges, redraw faces, or cartoonize geometry.
  const seen=new Uint8Array(n),clean=new Uint8Array(n);
  const minLength=Math.max(5,Math.round(conf.minComponent*(noise>=4?1.5:noise<=2?.7:1)*Math.min(w,h)/900));
  let scanned=0;
  for(let i=0;i<n;i++){
    if(selected[i]!==2||seen[i])continue;
    head=tail=0;queue[tail++]=i;seen[i]=1;
    while(head<tail){
      const index=queue[head++],x=index%w;
      for(let k=0;k<8;k++){
        if((x===0&&(k===0||k===3||k===5))||(x===w-1&&(k===2||k===4||k===7)))continue;
        const j=index+neighbors[k];
        if(j>=0&&j<n&&selected[j]===2&&!seen[j]){seen[j]=1;queue[tail++]=j;}
      }
    }
    if(tail>=minLength)for(let j=0;j<tail;j++)clean[queue[j]]=1;
    if(++scanned%1200===0)progress(82+4*i/n,'孤立した短い線を整理しています');
  }
  // Optional AI semantic segmentation acts as a guide only when a
  // corresponding natural image gradient exists; avoids invented outlines.
  if(aiLabels&&aiWidth&&aiHeight){
    const mask=new Uint16Array(aiLabels);
    const threshold=Math.max(6,low*.8);
    for(let y=2;y<h-2;y++){
      const sy=Math.min(aiHeight-1,Math.floor(y*aiHeight/h)),sy1=Math.min(aiHeight-1,Math.floor((y+1)*aiHeight/h));
      for(let x=2;x<w-2;x++){
        const sx=Math.min(aiWidth-1,Math.floor(x*aiWidth/w)),sx1=Math.min(aiWidth-1,Math.floor((x+1)*aiWidth/w));
        const id=mask[sy*aiWidth+sx];
        if(!id)continue;
        if(id===mask[sy*aiWidth+sx1]&&id===mask[sy1*aiWidth+sx])continue;
        const i=y*w+x;
        if(mag[i]>=threshold||mag[i-1]>=threshold||mag[i+1]>=threshold||mag[i-w]>=threshold||mag[i+w]>=threshold){
          // Add weak photo edges, not the raw blocky semantic boundary.
          let best=i;
          for(const v of [i-1,i+1,i-w,i+w])if(suppressed[v]>suppressed[best])best=v;
          if(suppressed[best]>threshold*.8)clean[best]=1;
        }
      }
      if(y%75===0)progress(86+3*y/h,'AI判定と元写真の輪郭を照合しています');
    }
  }
  progress(90,'白背景に黒線で仕上げています');
  const output=new Uint8ClampedArray(n*4);
  const strokeRadius=Math.min(2,Math.max(0,Math.round(Number(thickness)||1)-1));
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=y*w+x;
      let black=clean[i]===1;
      if(!black&&strokeRadius){
        loop:for(let dy=-strokeRadius;dy<=strokeRadius;dy++){
          const py=y+dy;if(py<0||py>=h)continue;
          for(let dx=-strokeRadius;dx<=strokeRadius;dx++){
            const px=x+dx;
            if(px<0||px>=w||dx*dx+dy*dy>strokeRadius*strokeRadius+.5)continue;
            if(clean[py*w+px]){black=true;break loop;}
          }
        }
      }
      const col=black?0:255,j=i*4;
      output[j]=col;output[j+1]=col;output[j+2]=col;output[j+3]=255;
    }
    if(y%70===0)progress(90+9*y/h,'PNG用の画像データを作っています');
  }
  progress(100,'完了');
  self.postMessage({type:'result',buffer:output.buffer,width:w,height:h},[output.buffer]);
}
