(function(){
if(window.VB)return;
const RM=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const rng=s=>{let a=s>>>0||1;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}};
const hash=str=>{let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const nz=x=>(Math.sin(x*1.7)+Math.sin(x*2.9+1.3)*.6+Math.sin(x*5.3+.7)*.3)/1.9;
const rgba=(hex,a)=>{const n=parseInt(hex.slice(1),16);return`rgba(${n>>16&255},${n>>8&255},${n&255},${a})`};
const f2=v=>v.toFixed(2);
const HX=h=>{const n=parseInt(h.slice(1),16);return[n>>16&255,n>>8&255,n&255]},ICE='#7cc8ff';
const mix=(a,aa,b,ba,t)=>{const A=parseInt(a.slice(1),16),B=parseInt(b.slice(1),16),l=(p,q)=>Math.round(p+(q-p)*t);return`rgba(${l(A>>16&255,B>>16&255)},${l(A>>8&255,B>>8&255)},${l(A&255,B&255)},${(aa+(ba-aa)*t).toFixed(3)})`};
const THEMES={
 transmission:{name:'transmission',bg:'#0b0b0c',panel:'#111113',ink:'#e9e5da',dim:'#8d8a82',accent:'#ff4b2b',amber:'#ffb23e',mono:'"JetBrains Mono", monospace',display:'"Big Shoulders Display", sans-serif'},
 dossier:{name:'dossier',bg:'#100f0c',panel:'#1a1813',ink:'#ddd5c1',dim:'#9d957f',accent:'#d8412a',amber:'#e3a93c',mono:'"Courier Prime", monospace',display:'"Saira Stencil One", sans-serif'}
};
const PRESETS={PACT:{depth:.72,grit:.45,machine:.35,space:.3},LEGION:{depth:.55,grit:.3,machine:.7,space:.5},ABYSS:{depth:.95,grit:.35,machine:.2,space:.75},UNIT:{depth:.4,grit:.2,machine:.9,space:.2},GHOST:{depth:.5,grit:.1,machine:.3,space:.95},SIGNAL:{depth:.3,grit:.6,machine:.6,space:.35},RAW:{depth:0,grit:0,machine:0,space:0}};
const PNAMES=Object.keys(PRESETS);
const KNOBS=[{id:'depth',label:'DEPTH',maps:['PITCH','FORMANT','SUB']},{id:'grit',label:'GRIT',maps:['DRIVE','CRUSH','FUZZ']},{id:'machine',label:'MACHINE',maps:['RING','VOCODE','GATE']},{id:'space',label:'SPACE',maps:['VERB','DELAY','WIDTH']}];
function mapVals(id,v){switch(id){
 case'depth':return[`${(-v*9).toFixed(1)} st`,`${(-v*4).toFixed(1)}`,`+${Math.round(v*60)}%`];
 case'grit':return[`${Math.round(v*18)} dB`,`${16-Math.round(v*10)} bit`,`${Math.round(v*40)}%`];
 case'machine':return[`${Math.round(30+v*60)} Hz`,`${Math.round(v*100)}%`,`${Math.round(v*50)}%`];
 default:return[`${(0.4+v*3.2).toFixed(1)} s`,v>.5?'1/8':'1/16',`${Math.round(100+v*60)}%`];}}
const VOICES=[{id:'fenrir',name:'Fenrir',desc:'US male',tags:['LOW','GRAVEL'],f0:96},{id:'michael',name:'Michael',desc:'US male',tags:['NEUTRAL'],f0:112},{id:'puck',name:'Puck',desc:'US male',tags:['BRIGHT','FAST'],f0:124},{id:'george',name:'George',desc:'UK male',tags:['CRISP'],f0:106},{id:'heart',name:'Heart',desc:'US female',tags:['AIRY'],f0:192}];
const KEYS=['Am · 8A','Em · 9A','Bm · 10A','F#m · 11A','Dm · 7A','Gm · 6A','Cm · 5A','Fm · 4A'];
const BARS=['1','2','4','8','16','FREE'];
const FORMATS=['AIFF 24/44.1','WAV 24/48','AIFF 24/48'];
const P=(id,label,kind,o={})=>({id,label,kind,unit:o.u||'',min:o.min??0,max:o.max??100,step:o.st||1,def:o.d??50,adv:!!o.adv,options:o.opt||null});
const RACKDEF=[
 ['PREP',[P('gate','GATE','knob',{u:'dB',min:-80,max:-20,d:-52}),P('deess','DE-ESS','fader',{u:'%',d:35}),P('trim','TRIM','number',{u:'dB',min:-12,max:12,st:.5,d:0}),P('hpf','HPF','select',{opt:['OFF','40 Hz','80 Hz','120 Hz'],d:2,adv:true})]],
 ['MASK',[P('pitch','PITCH','knob',{u:'st',min:-12,max:12,st:.1,d:-6.5}),P('formant','FORMANT','knob',{min:-6,max:6,st:.1,d:-2.9}),P('blend','BLEND','fader',{u:'%',d:100}),P('algo','ALGO','segmented',{opt:['PSOLA','WORLD','SPEC'],d:1,adv:true}),P('grain','GRAIN','number',{u:'ms',min:5,max:80,d:22,adv:true})]],
 ['LAYERS',[P('oct1','OCT −1','fader',{u:'%',d:45}),P('oct2','OCT −2','fader',{u:'%',d:20}),P('whisper','WHISPER','fader',{u:'%',d:30}),P('spread','SPREAD','knob',{u:'%',d:60}),P('stack','STACK VOICE','select',{opt:['NONE','Michael','George','Heart'],d:0,adv:true})]],
 ['MACHINE',[P('ring','RING','knob',{u:'Hz',min:20,max:200,d:62}),P('vocode','VOCODE','fader',{u:'%',d:40}),P('carrier','CARRIER','segmented',{opt:['SAW','SQR','NOISE'],d:0}),P('bands','BANDS','number',{min:8,max:40,d:16,adv:true}),P('gate2','GATE','switch',{d:1,adv:true}),P('grate','GATE RATE','select',{opt:['1/8','1/16','1/32'],d:1,adv:true})]],
 ['DRIVE',[P('drive','DRIVE','knob',{u:'dB',min:0,max:24,d:9}),P('tone','TONE','knob',{u:'%',d:55}),P('mix','MIX','fader',{u:'%',d:70}),P('mode','MODE','segmented',{opt:['TAPE','TUBE','FUZZ'],d:1})]],
 ['CRUSH',[P('bits','BITS','number',{u:'bit',min:4,max:16,d:11}),P('rate','RATE','knob',{u:'kHz',min:2,max:44,st:.1,d:18}),P('mix','MIX','fader',{u:'%',d:40})]],
 ['TONE',[P('low','LOW','knob',{u:'dB',min:-12,max:12,st:.5,d:3}),P('mid','MID','knob',{u:'dB',min:-12,max:12,st:.5,d:-2}),P('high','HIGH','knob',{u:'dB',min:-12,max:12,st:.5,d:-4}),P('tilt','TILT','fader',{min:-50,max:50,d:-10,adv:true})]],
 ['MOTION',[P('rate','RATE','select',{opt:['1/4','1/8','1/16','FREE'],d:1}),P('depth','DEPTH','fader',{u:'%',d:25}),P('shape','SHAPE','segmented',{opt:['SIN','TRI','S&H'],d:2})]],
 ['DYNAMICS',[P('thresh','THRESH','knob',{u:'dB',min:-40,max:0,d:-18}),P('ratio','RATIO','number',{u:':1',min:1,max:20,st:.5,d:4}),P('attack','ATTACK','fader',{u:'ms',min:.1,max:50,st:.1,d:3,adv:true}),P('release','RELEASE','fader',{u:'ms',min:10,max:500,d:120,adv:true})]],
 ['SPACE',[P('size','SIZE','knob',{u:'%',d:55}),P('decay','DECAY','knob',{u:'s',min:.2,max:8,st:.1,d:2.4}),P('pre','PRE-DELAY','number',{u:'ms',min:0,max:120,d:18}),P('mix','MIX','fader',{u:'%',d:28}),P('duck','DUCK','switch',{d:1,adv:true})]],
 ['STEREO',[P('width','WIDTH','fader',{u:'%',min:0,max:200,d:130}),P('haas','HAAS','number',{u:'ms',min:0,max:30,d:8}),P('monob','MONO BASS','switch',{d:1})]],
 ['ARRANGE',[P('stutter','STUTTER','select',{opt:['OFF','1/8','1/16'],d:0}),P('reverse','REVERSE TAIL','switch',{d:0}),P('tail','TAIL','fader',{u:'bars',min:0,max:4,d:1})],'Arrives with engine 0.10. Bypassed until then.'],
 ['MASTER',[P('ceiling','CEILING','number',{u:'dBTP',min:-3,max:0,st:.1,d:-1}),P('lufs','TARGET','number',{u:'LUFS',min:-14,max:-5,st:.1,d:-7}),P('limit','LIMITER','switch',{d:1}),P('os','OVERSAMPLE','segmented',{opt:['2×','4×','8×'],d:1,adv:true})]]
];
const BOOT={
 transmission:['FOXBOX  0.9.4  arm64','AUDIO   coreaudio · 48 kHz · 2 ch · 128 smp','ENGINE  spawn tts worker ......... pid 4471','MODEL   kokoro-82m.onnx','LEXICON FVWKS → "Fawkes" · 12 entries','DSP     13 modules · 4 macros · 64-bit','LINK    carrier locked · 140.00 BPM','READY   WE ARE LISTENING.'],
 dossier:['FILE FOXBOX-0042 — RESTRICTED','SUBJECT ......... GUY FVWKS','AUDIO ........... COREAUDIO 48 KHZ','MODEL ........... KOKORO-82M','LEXICON ......... FVWKS = "FAWKES"','MODULES ......... 13 / MACROS 4','CLEARANCE ....... GRANTED','STATUS: DECLASSIFIED. REMEMBER.']
};
const SHORTCUTS=[['SPACE','Play / stop'],['⌘ ↩','Final render'],['⌘ E','Export'],['\\','A/B dry · wet'],['L','Loop'],['1 – 7','Presets'],['⌘ S','Save preset'],['R','Record (Record tab)'],['?','This overlay']];

function estimate(script,speed){const clean=script.replace(/\[[0-9.]+\]/g,'');const letters=(clean.match(/[a-z0-9]/gi)||[]).length;let p=0;script.replace(/\[([0-9.]+)\]/g,(m,a)=>{p+=parseFloat(a)||0;return m});const ticks=(script.match(/\|/g)||[]).length;return Math.max(.4,(0.5+letters*.3+ticks*.4)/speed+p)}
function tokenize(s){const out=[];const re=/(\|)|(\[[0-9.]+\])|(\*[^*\n]+\*)/g;let last=0,m;while((m=re.exec(s))){if(m.index>last)out.push({t:s.slice(last,m.index),k:'txt'});out.push({t:m[0],k:m[1]?'tick':m[2]?'pause':'throw'});last=re.lastIndex}if(last<s.length)out.push({t:s.slice(last),k:'txt'});out.push({t:' ',k:'txt'});return out.map((o,i)=>({t:o.t,i,isTxt:o.k==='txt',isTick:o.k==='tick',isPause:o.k==='pause',isThrow:o.k==='throw'}))}
function buildSchedule(script,total,seed){
 const units=[];const re=/\[([0-9.]+)\]|\||\*([^*]+)\*|([A-Za-z0-9'’]+)/g;let m;
 while((m=re.exec(script))){if(m[1])units.push({p:parseFloat(m[1])||0});else if(m[0]==='|')units.push({p:.16,tick:true});else{(m[2]?m[2].split(/\s+/).filter(Boolean):[m[3]]).forEach(w=>units.push({w:w.toUpperCase(),th:!!m[2]}))}}
 let W=0,P=0;units.forEach(u=>{if(u.w){u.syl=Math.max(1,Math.round(u.w.length/2.4));u.wt=u.w.length+1.2;W+=u.wt}else P+=u.p});
 const r=rng(seed),gap=.05,speech=Math.max(.4,total-P-.12);let t=.06;const syl=[],words=[];
 units.forEach(u=>{if(!u.w){t+=u.p;return}const d=speech*u.wt/Math.max(W,1)-gap;const w0=t;for(let i=0;i<u.syl;i++){const sd=d/u.syl;syl.push({t0:t,d:sd*.9,amp:(u.th?1:.74+r()*.18)*(i?.86:1),f1:320+r()*460,f2:950+r()*1350,noise:r()<.4,pitch:1+(r()-.5)*.14+(u.th?.14:0)});t+=sd}words.push({w:u.w,t0:w0,t1:t,th:u.th});t+=gap});
 return{syl,words,len:Math.max(t,total)};
}
function waveData(sch,len,k,dry,N,loud){
 const a=new Float32Array(N),r=rng(7),g=dry?0:k.grit,m=dry?0:k.machine,sp=dry?0:k.space;
 for(let i=0;i<N;i++){const t=i/N*len;let v=0;for(const s of sch.syl){if(t<s.t0-.02||t>s.t0+s.d+.4)continue;const x=(t-s.t0)/s.d;const e=x<0?0:x<.15?x/.15:x<1?1-(x-.15)*.35:.65*Math.exp(-(x-1)*s.d*16);v=Math.max(v,e*s.amp)}
  v=Math.pow(v,1-g*.55);if(m>0)v*=1-m*.4*(Math.sin(t*(30+m*60)*6.283)>0?0:1);a[i]=v*(.55+.45*r()*(1+g*.6))}
 if(sp>0){const dec=Math.exp(-(len/N)/(.12+sp*1.1));let y=0;for(let i=0;i<N;i++){y=Math.max(a[i],y*dec);a[i]=Math.max(a[i],y*.55*sp*(.6+.4*r()))}}
 let mx=0;for(const v of a)mx=Math.max(mx,v);const tgt=loud==='CLUB'?.96:.8;for(let i=0;i<N;i++)a[i]=Math.min(1,a[i]/(mx||1)*tgt);return a;
}
function bandData(sch,len,k,dry,N){const lo=new Float32Array(N),mi=new Float32Array(N),hi=new Float32Array(N),K=dry?{depth:0,grit:0,machine:0,space:0}:k;
 for(let i=0;i<N;i++){const t=i/N*len;let best=null,be=0;for(const s of sch.syl){if(t<s.t0-.02||t>s.t0+s.d+.5)continue;const x=(t-s.t0)/s.d,e=x<0?.1:x<1?1:Math.exp(-(x-1)*3);if(e>be){be=e;best=s}}
  let l,m,h;if(!best){l=.2;m=.3;h=.5}else{const br=clamp((best.f2-950)/1350),dt=t-best.t0,tail=dt>best.d;
   if(best.noise&&dt<.07){l=.08;m=.25;h=1}else{l=.15+.85*(1-br);m=.25+.75*(1-Math.abs(br-.5)*2);h=.05+.8*br*br}
   if(tail){l*=.5;m*=.7;h=Math.max(h,.25+K.space*.6)}}
  lo[i]=l*(.7+K.depth*.6);mi[i]=m*(.8+K.machine*.5);hi[i]=h*(.75+K.grit*.8)}
 return{lo,mi,hi}}
let NB=null;const noiseBuf=ac=>{if(NB)return NB;NB=ac.createBuffer(1,ac.sampleRate,ac.sampleRate);const d=NB.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;return NB};
function impulse(ac,dur){const n=Math.floor(ac.sampleRate*dur),b=ac.createBuffer(2,n,ac.sampleRate);for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/n,2.6)}return b}
function curve(g){const n=1024,c=new Float32Array(n),k=g*60,st=g>.4?Math.pow(2,16-g*11):0;for(let i=0;i<n;i++){const x=i/(n-1)*2-1;let y=((1+k)*x)/(1+k*Math.abs(x));if(st)y=Math.round(y*st)/st;c[i]=y}return c}
function synth(ac,out,sch,o){
 const t0=o.t0,k=o.dry?{depth:0,grit:0,machine:0,space:0}:o.k,len=sch.len;
 const pm=Math.pow(2,-k.depth*9/12),fs=Math.pow(2,-k.depth*4/12);
 const master=ac.createGain();master.gain.value=0;master.connect(out);
 const osc=ac.createOscillator();osc.type='sawtooth';const sub=ac.createOscillator();sub.type='square';
 const vg=ac.createGain();vg.gain.value=0;osc.connect(vg);const sg=ac.createGain();sg.gain.value=k.depth*.45;sub.connect(sg).connect(vg);
 const ns=ac.createBufferSource();ns.buffer=noiseBuf(ac);ns.loop=true;const hp=ac.createBiquadFilter();hp.type='highpass';hp.frequency.value=3200;const ng=ac.createGain();ng.gain.value=0;ns.connect(hp).connect(ng);
 const sum=ac.createGain();sum.gain.value=2.2;
 const F=[0,1,2].map(i=>{const b=ac.createBiquadFilter();b.type='bandpass';b.Q.value=[5,8,11][i];vg.connect(b);const g=ac.createGain();g.gain.value=[1.6,1.1,.55][i];b.connect(g).connect(sum);return b});
 ng.connect(sum);
 const sh=ac.createWaveShaper();sh.curve=curve(k.grit);sum.connect(sh);
 const rm=ac.createGain();rm.gain.value=1-k.machine*.45;const lfo=ac.createOscillator();lfo.frequency.value=30+k.machine*60;const lg=ac.createGain();lg.gain.value=k.machine*.45;lfo.connect(lg).connect(rm.gain);sh.connect(rm);
 const lp=ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=9000-k.depth*4200;rm.connect(lp);
 const comp=ac.createDynamicsCompressor();comp.threshold.value=-26;comp.ratio.value=6;comp.attack.value=.004;comp.release.value=.12;lp.connect(comp);
 if(k.space>.02){const cv=ac.createConvolver();cv.buffer=impulse(ac,.4+k.space*3.2);const wg=ac.createGain();wg.gain.value=k.space*.9;lp.connect(cv).connect(wg).connect(comp)}
 comp.connect(master);master.gain.setValueAtTime(1.4,t0);
 const f0=o.f0*pm;osc.frequency.setValueAtTime(f0,t0);sub.frequency.setValueAtTime(f0/2,t0);F[2].frequency.value=2600*fs;
 sch.syl.forEach(s=>{const a=t0+s.t0,decl=1-.1*s.t0/len,f=f0*s.pitch*decl;vg.gain.setTargetAtTime(s.amp*.55,a,.012);vg.gain.setTargetAtTime(0,a+s.d*.82,.03);osc.frequency.setTargetAtTime(f,a,.03);sub.frequency.setTargetAtTime(f/2,a,.03);F[0].frequency.setTargetAtTime(s.f1*fs,a,.018);F[1].frequency.setTargetAtTime(s.f2*fs,a,.018);if(s.noise){ng.gain.setTargetAtTime(.22,a,.004);ng.gain.setTargetAtTime(0,a+.045,.015)}});
 const end=t0+len+.3+k.space*3.2;[osc,sub,ns,lfo].forEach(n=>{n.start(t0);n.stop(end)});
 return{stop(){try{const n=ac.currentTime;master.gain.cancelScheduledValues(n);master.gain.setTargetAtTime(0,n,.02);[osc,sub,ns,lfo].forEach(x=>x.stop(n+.12))}catch(e){}}};
}
function prep(cv){if(!cv)return null;const w=cv.clientWidth,h=cv.clientHeight;if(!w||!h)return null;const d=2;if(cv.width!==w*d||cv.height!==h*d){cv.width=w*d;cv.height=h*d}const x=cv.getContext('2d');x.setTransform(d,0,0,d,0,0);return{x,w,h}}
const GLY='0123456789ABCDEF#%/<>=+';

function drawWave(cv,C,now){
 const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,s=C.s,g=C.geom();
 x.clearRect(0,0,w,h);const top=28,bot=h-30,mid=Math.round((top+bot)/2),amp=(bot-top)/2-6,X=t=>t/g.viewLen*w;
 x.font=`500 9.5px ${th.mono}`;x.textBaseline='middle';x.textAlign='left';
 if(s.loop){x.fillStyle=rgba(th.amber,.05);x.fillRect(0,top,X(g.target),bot-top);x.fillStyle=rgba(th.amber,.7);x.fillRect(0,top-2,X(g.target),1)}
 if(g.len>g.target+.01){const x0=X(g.target),x1=X(g.len);x.save();x.beginPath();x.rect(x0,top,x1-x0,bot-top);x.clip();x.strokeStyle=rgba(th.accent,.12);x.lineWidth=1;for(let i=-h;i<x1-x0+h;i+=6){x.beginPath();x.moveTo(x0+i,bot);x.lineTo(x0+i+h,top);x.stroke()}x.restore()}
 const bd=g.barDur,pt=C.playT!=null&&C.playT>=0?C.playT:null,beat=pt!=null?Math.floor(pt/(bd/4)):-1;
 for(let b=0;b<=g.barCount;b++){const bx=Math.round(X(b*bd));x.fillStyle=rgba(th.ink,.1);x.fillRect(bx,top-8,1,bot-top+8);if(b<g.barCount){x.fillStyle=th.dim;x.fillText(String(b+1),bx+5,top-15)}}
 for(let q=0;q<g.barCount*4;q++){const qx=Math.round(X(q*bd/4)),on=q===beat;if(q%4){x.fillStyle=rgba(th.ink,.035);x.fillRect(qx,top,1,bot-top)}x.fillStyle=on?th.amber:rgba(th.ink,q%4?.16:.3);x.fillRect(qx,top-6,on?3:1,on?6:3)}
 x.fillStyle=rgba(th.ink,.06);x.fillRect(0,mid,w,1);
 const ex=Math.round(X(g.target));x.fillStyle=th.accent;x.fillRect(ex,top-8,1,bot-top+8);x.textAlign='right';x.fillText(`END ${f2(g.target)}s`,ex-5,top-15);x.textAlign='left';
 const cols=Math.max(2,Math.ceil(w/2)),idx=c=>Math.floor(c*2/w*g.viewLen/C.len*900);
 const shape=arr=>{const o=new Float32Array(cols+1);if(!arr)return o;const N=arr.length;for(let c=0;c<=cols;c++){const i=Math.floor(c*2/w*g.viewLen/C.len*N);if(i<0||i>=N)continue;let m=arr[i];if(i>0)m=Math.max(m,arr[i-1]*.85);if(i<N-1)m=Math.max(m,arr[i+1]*.85);o[c]=m}return o};
 const bcol=arr=>{const o=new Float32Array(cols+1);if(!arr)return o;for(let c=0;c<=cols;c++){const i=idx(c);let t=0,n=0;for(let k=-3;k<=3;k++){const q=arr[i+k*2];if(q!==undefined){t+=q;n++}}o[c]=n?t/n:0}return o};
 const smooth=a=>{const o=new Float32Array(a.length);for(let c=0;c<a.length;c++){let t=0,n=0;for(let k=-3;k<=3;k++){const q=a[c+k];if(q!==undefined){t+=q;n++}}o[c]=t/n*.58}return o};
 const env=(v,c0,c1)=>{x.beginPath();x.moveTo(c0*2,mid);for(let c=c0;c<=c1;c++)x.lineTo(c*2,mid-Math.max(.5,v[c]*amp));for(let c=c1;c>=c0;c--)x.lineTo(c*2,mid+Math.max(.5,v[c]*amp*.9));x.closePath()};
 const cur=s.dry?C.waveDry:C.wave,old=s.dry?C.oldWaveDry:C.oldWave,B=s.dry?C.bandsDry:C.bands,sw=C.sweep,p=sw?C.sweepP:1,sm=C.stMix||0;
 const v=shape(cur);if(sw&&sw.mode==='morph'&&old){const o=shape(old),e=1-Math.pow(1-p,3);for(let c=0;c<=cols;c++)v[c]=o[c]+(v[c]-o[c])*e}
 const vi=smooth(v),bl=bcol(B&&B.lo),bm=bcol(B&&B.mi),bh=bcol(B&&B.hi),CL=HX(th.accent),CM=HX(th.amber),CH=HX(ICE),CG=HX(th.ink);
 const colAt=c=>{const l=bl[c],m=bm[c],hh=bh[c],sum=l+m+hh||1,r=[0,1,2].map(k=>(CL[k]*l+CM[k]*m+CH[k]*hh)/sum),gray=.5*(r[0]+r[1]+r[2])/3+.5*CG[0]*.35;return r.map(q=>Math.round(q+(gray-q)*sm*.9))};
 if(!C.off)C.off=document.createElement('canvas');const O=C.off;if(O.width!==cv.width||O.height!==cv.height){O.width=cv.width;O.height=cv.height}const o=O.getContext('2d');o.setTransform(cv.width/w,0,0,cv.height/h,0,0);o.clearRect(0,0,w,h);
 for(let c=0;c<=cols;c++){const k=colAt(c),hp=Math.max(.5,v[c]*amp),hr=Math.max(.5,vi[c]*amp),st='rgb('+k[0]+','+k[1]+','+k[2]+')';o.globalAlpha=.5*(1-sm*.5);o.fillStyle=st;o.fillRect(c*2,mid-hp,2,hp+hp*.9);o.globalAlpha=1-sm*.55;o.fillRect(c*2,mid-hr,2,hr+hr*.9)}
 o.globalAlpha=1;o.globalCompositeOperation='source-atop';const vg=o.createLinearGradient(0,mid-amp,0,mid+amp);vg.addColorStop(0,'rgba(255,255,255,'+(.42*(1-sm))+')');vg.addColorStop(.4,'rgba(255,255,255,0)');vg.addColorStop(.5,'rgba(0,0,0,.18)');vg.addColorStop(.6,'rgba(255,255,255,0)');vg.addColorStop(1,'rgba(255,255,255,'+(.3*(1-sm))+')');o.fillStyle=vg;o.fillRect(0,mid-amp-4,w,amp*2+8);o.globalCompositeOperation='source-over';
 if(sw&&sw.mode==='reveal'){const e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2,sx=e*(w+60);
  if(old){const ov=shape(old);x.save();x.beginPath();x.rect(sx,0,w,h);x.clip();x.fillStyle=rgba(th.ink,.08);env(ov,0,cols);x.fill();x.fillStyle=rgba(th.ink,.16);env(smooth(ov),0,cols);x.fill();x.restore()}
  x.save();x.beginPath();x.rect(0,0,Math.max(0,sx),h);x.clip();x.drawImage(O,0,0,w,h);const gf=x.createLinearGradient(sx-70,0,sx,0);gf.addColorStop(0,rgba(th.panel,0));gf.addColorStop(1,rgba(th.panel,.95));x.fillStyle=gf;x.fillRect(sx-70,top-4,70,bot-top+8);x.restore();
  if(p<1){x.fillStyle=rgba(th.accent,sw.final?.85:.5);x.fillRect(Math.round(Math.min(sx,w-1)),top,1,bot-top)}
 }else{const px=pt!=null?Math.round(X(pt)):-1;if(px>0){x.save();x.beginPath();x.rect(0,0,px,h);x.clip();x.globalAlpha=.4;x.drawImage(O,0,0,w,h);x.restore();x.globalAlpha=1;x.save();x.beginPath();x.rect(px,0,w-px,h);x.clip();x.drawImage(O,0,0,w,h);x.restore()}else x.drawImage(O,0,0,w,h)}
 if(s.phase==='SYNTHESIZING'){const bx=((now/1300)%1)*(w+300)-150,gs=x.createLinearGradient(bx-150,0,bx+150,0);gs.addColorStop(0,rgba(th.ink,0));gs.addColorStop(.5,rgba(th.ink,.42));gs.addColorStop(1,rgba(th.ink,0));x.fillStyle=gs;env(v,0,cols);x.fill()}
 const ry=bot+8;(C.sched?C.sched.words:[]).forEach(wd=>{const a=X(wd.t0),said=pt!=null&&pt>=wd.t0;x.fillStyle=said?th.amber:rgba(th.ink,.22);x.fillRect(a,ry,1,12);x.fillStyle=wd.th?th.accent:(said?th.ink:th.dim);x.fillText(wd.w,a+5,ry+7)});
 if(pt!=null){const px=Math.round(X(pt));x.fillStyle=th.ink;x.fillRect(px,top-8,1,bot-top+26);x.beginPath();x.moveTo(px-4,top-10);x.lineTo(px+5,top-10);x.lineTo(px+.5,top-5);x.fill()}
}

function drawCore(cv,C,tt){
 const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,s=C.s,g=C.geom(),t=tt,TAU=6.2832;
 const cx=w/2,cy=h/2-10,R=Math.max(26,Math.min(w*.5-22,h*.5-46)*.8),pl=s.playing||C.aud,lv=C.lvl,pt=C.playT!=null&&C.playT>=0?C.playT:null,sm=C.stMix||0;
 const E=C.r?C.r.k:C.eff(),NBk=48,sr=C.ac?C.ac.sampleRate:48000;
 if(!C.orb){const N=520;C.orb=Array.from({length:N},(_,i)=>{const y=1-2*(i+.5)/N,r=Math.sqrt(1-y*y),ph=i*2.39996;return[Math.cos(ph)*r,y,Math.sin(ph)*r,ph]})}
 for(let k=0;k<NBk;k++){let v;if(pl&&C.bins){const b=Math.min(511,Math.max(1,Math.round(70*Math.pow(140,k/(NBk-1))/(sr/1024))));v=C.bins[b]/255}else v=.045+.012*nz(k*.22+t*.35);C.sm[k]+=(v-C.sm[k])*(v>C.sm[k]?.45:.08)}
 x.clearRect(0,0,w,h);
 const gl=x.createRadialGradient(cx,cy,0,cx,cy,R*1.5);gl.addColorStop(0,rgba(th.amber,.05+lv*.28));gl.addColorStop(.6,rgba(th.accent,.02+lv*.1));gl.addColorStop(1,rgba(th.accent,0));x.fillStyle=gl;x.fillRect(0,0,w,h);
 const rot=t*.22+(C.beatPulse*.02),tilt=.38,cr=Math.cos(rot),sr2=Math.sin(rot),ct=Math.cos(tilt),st=Math.sin(tilt);
 const rings=E.machine>.05?Math.max(5,Math.round(22-E.machine*16)):0;
 const cLo=mix(th.accent,1,th.ink,.3,sm),cMi=mix(th.amber,1,th.ink,.3,sm),cHi=mix(th.ink,1,th.ink,.3,sm);
 x.globalCompositeOperation='lighter';
 const shell=(scale,alphaK,step)=>{for(let n=0;n<C.orb.length;n+=step){let[px,py,pz,ph]=C.orb[n];if(rings){py=Math.round(py*rings)/rings;const r=Math.sqrt(Math.max(0,1-py*py));px=Math.cos(ph)*r;pz=Math.sin(ph)*r}
   const band=Math.min(NBk-1,Math.floor((py+1)/2*NBk)),e=C.sm[band];let d=e*(.5+(py<0?E.depth*.45:0))+.014*nz(px*2.2+py*1.7+t*.4)+(pl&&E.grit>.05?(Math.random()-.5)*E.grit*.1*e:0);
   const rr=scale*(1+d),X=px*rr,Y=py*rr*(1-E.depth*.08),Z=pz*rr,x1=X*cr+Z*sr2,z1=-X*sr2+Z*cr,y2=Y*ct-z1*st,z2=Y*st+z1*ct,f=2.8/(2.8-z2),sx=cx+x1*R*f,sy=cy-y2*R*f,depth=(z2+1.2)/2.4;
   x.globalAlpha=Math.min(1,(.12+depth*.55+e*.9)*alphaK);x.fillStyle=py<-.34?cLo:py<.34?cMi:cHi;const sz=(.7+depth*1.5)*(1+e*1.2);x.fillRect(sx-sz/2,sy-sz/2,sz,sz)}};
 if(E.space>.05)shell(1.22+E.space*.18,.22*E.space,2);
 shell(1,1,1);
 x.globalAlpha=1;x.globalCompositeOperation='source-over';
 const ly=cy+R*1.42+4;x.textAlign='center';x.textBaseline='middle';
 const wd=pt!=null&&C.sched?C.sched.words.find(q=>pt>=q.t0&&pt<q.t1+.05):null;
 x.font=`800 ${Math.round(Math.min(22,R*.3))}px ${th.display}`;x.fillStyle=wd&&wd.th?th.accent:th.ink;x.fillText(pt!=null?(wd?wd.w:'·'):f2(g.target)+' S',cx,ly);
 x.font=`500 8.5px ${th.mono}`;x.fillStyle=th.dim;x.fillText(pt!=null?'BAR '+(Math.floor(pt/g.barDur)+1)+'.'+(Math.floor((pt%g.barDur)/(g.barDur/4))+1):g.barCount+' BARS @ '+Math.round(240/g.barDur),cx,ly+16);
 const vc=VOICES.find(q=>q.id===(C.r?C.r.voice:s.voice))||VOICES[0],f0=vc.f0*Math.pow(2,-E.depth*9/12);
 x.font=`600 9.5px ${th.mono}`;x.textAlign='left';x.fillText('F0 '+Math.round(f0)+' Hz',14,h-15);x.textAlign='right';x.fillText(pl?'RMS '+(lv>.001?(20*Math.log10(lv)).toFixed(1):'−∞')+' dB':s.phase?'PROCESSING':'RING '+Math.round(30+E.machine*60)+' Hz',w-14,h-15);
 x.textAlign='right';x.fillStyle=th.dim;x.fillText('HIGH',w-14,cy-R*.75);x.fillText('MID',w-14,cy);x.fillText('LOW',w-14,cy+R*.75);x.textAlign='left';
}
function drawMeter(cv,C){
 const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,D=th.name==='dossier',m=C.meter,st=C.stats();
 x.clearRect(0,0,w,h);x.font=`600 10px ${th.mono}`;x.textBaseline='middle';
 const rows=[['ST',C.s.playing?m.st:st.lufs,C.s.playing?m.stMax:st.lufs,st.target,'LUFS'],['TP',C.s.playing?m.tp:st.tp,C.s.playing?m.tpHold:st.tp,-1,'dBTP']];
 const lx=30,rx=w-78,bw=rx-lx-8,sc=v=>clamp((v+24)/24);
 rows.forEach((r,i)=>{const y=12+i*30;x.fillStyle=th.dim;x.fillText(r[0],0,y+5);
  if(D){x.fillStyle=rgba(th.ink,.1);x.fillRect(lx,y+1,bw,8);x.fillStyle=r[1]>-1&&i?th.accent:th.ink;x.fillRect(lx,y+1,bw*sc(r[1]),8);for(let d=0;d<=24;d+=6){x.fillStyle=rgba(th.ink,.35);x.fillRect(lx+bw*(1-d/24),y+11,1,3)}}
  else{const n=40,cw=bw/n;for(let j=0;j<n;j++){const on=j/n<sc(r[1]),db=-24+j/n*24;x.fillStyle=on?(db>-1?th.accent:db>-8?th.amber:rgba(th.amber,.6)):rgba(th.ink,.07);x.fillRect(lx+j*cw,y,cw-1.2,10)}}
  x.fillStyle=th.ink;x.fillRect(lx+bw*sc(r[2])-1,y-2,2,14);
  x.fillStyle=th.accent;x.fillRect(lx+bw*sc(r[3]),y-4,1,18);
  x.fillStyle=r[2]>r[3]+.05&&i?th.accent:th.ink;x.font=`700 12px ${th.mono}`;x.fillText(r[2].toFixed(1),rx,y+5);x.font=`500 9px ${th.mono}`;x.fillStyle=th.dim;x.fillText(r[4],rx+38,y+5);x.font=`600 10px ${th.mono}`});
}
function drawMini(cv,C){const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,wv=C.wave,B=C.bands;x.clearRect(0,0,w,h);if(!wv||!B)return;const n=Math.floor(w/2),m=h/2,at=(a,i)=>a[Math.min(a.length-1,Math.floor(i/n*a.length))],CL=HX(th.accent),CM=HX(th.amber),CH=HX(ICE);
 for(let i=0;i<=n;i++){const l=at(B.lo,i),mm=at(B.mi,i),hh=at(B.hi,i),sm=l+mm+hh||1,k=[0,1,2].map(q=>Math.round((CL[q]*l+CM[q]*mm+CH[q]*hh)/sm)),v=at(wv,i),hp=Math.max(.5,v*(m-2));x.fillStyle='rgb('+k.join(',')+')';x.globalAlpha=.55;x.fillRect(i*2,m-hp,2,hp*1.9);x.globalAlpha=1;x.fillRect(i*2,m-hp*.55,2,hp*.55*1.9)}}
function drawRec(cv,C){const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,L=C.inLvl||0,pk=C.inPk||0;x.clearRect(0,0,w,h);const n=48,cw=w/n,db=v=>v>0?20*Math.log10(v):-60,pos=v=>clamp((db(v)+48)/48),lp=pos(L),pp=pos(pk);for(let i=0;i<n;i++){const f=i/n,on=f<lp;x.fillStyle=on?(f>.875?th.accent:f>.75?th.amber:rgba(th.amber,.55)):rgba(th.ink,.07);x.fillRect(i*cw,0,cw-1.5,h)}x.fillStyle=th.ink;x.fillRect(Math.max(0,pp*w-2),0,2,h)}
function drawOrb(cv,C,now){const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,s=C.s,cx=w/2,cy=h/2,R=Math.min(w,h)*.34,L=C.inLvl||0,H=C.inHist,n=H.length,st=s.rec,t=now/1000,TAU=6.2832,A0=-1.5708;
 x.clearRect(0,0,w,h);x.strokeStyle=rgba(th.ink,.06);x.lineWidth=1;x.beginPath();x.arc(cx,cy,R*1.5,0,TAU);x.stroke();x.setLineDash([1,5]);x.beginPath();x.arc(cx,cy,R*.8,0,TAU);x.stroke();x.setLineDash([]);
 const N=120;x.lineWidth=2;for(let i=0;i<N;i++){const v=H[(C.hi-1-i*2+n*4)%n],a=A0+i/N*TAU,ca=Math.cos(a),sa=Math.sin(a),r0=R*1.03,len=st==='rec'?3+v*R*.4:2+v*R*.28,fade=1-i/N*.7;x.strokeStyle=st==='rec'?(v>.8?th.accent:rgba(th.amber,(.35+v*.65)*fade)):rgba(th.ink,(.16+v*2.2)*fade);x.beginPath();x.moveTo(cx+ca*r0,cy+sa*r0);x.lineTo(cx+ca*(r0+len),cy+sa*(r0+len));x.stroke()}
 const Rp=R*1.38,target=s.bars==='FREE'?0:+s.bars*240/s.bpm,nb=s.bars==='FREE'?0:+s.bars;x.strokeStyle=rgba(th.ink,.08);x.lineWidth=2;x.beginPath();x.arc(cx,cy,Rp,0,TAU);x.stroke();
 for(let k=0;k<nb;k++){const a=A0+k/nb*TAU;x.fillStyle=rgba(th.ink,.4);x.fillRect(cx+Math.cos(a)*Rp-1.5,cy+Math.sin(a)*Rp-1.5,3,3)}
 if(st==='rec'){const el=(now-C.recT0)/1000,f=target?clamp(el/target):(el%8)/8,ea=A0+f*TAU;x.strokeStyle=th.accent;x.shadowColor=th.accent;x.shadowBlur=10;x.beginPath();x.arc(cx,cy,Rp,A0,ea);x.stroke();x.shadowBlur=0;x.fillStyle=th.ink;x.beginPath();x.arc(cx+Math.cos(ea)*Rp,cy+Math.sin(ea)*Rp,3.5,0,TAU);x.fill()}
 const br=R*.62*(st==='rec'?1+L*.1:1+.015*Math.sin(t*1.7));
 if(st==='rec'){x.fillStyle=th.accent;x.shadowColor=th.accent;x.shadowBlur=18+L*40;x.beginPath();x.arc(cx,cy,br,0,TAU);x.fill();x.shadowBlur=0;x.fillStyle=rgba('#ffffff',.06+L*.14);x.beginPath();x.arc(cx,cy,br*.72,0,TAU);x.fill()}
 else{const c=st==='count'?th.amber:th.accent;x.fillStyle=rgba(c,.07);x.beginPath();x.arc(cx,cy,br,0,TAU);x.fill();x.strokeStyle=rgba(c,.85);x.lineWidth=2;x.beginPath();x.arc(cx,cy,br,0,TAU);x.stroke();if(st==='idle'){const sa=t*.9;x.strokeStyle=rgba(th.accent,.45);x.beginPath();x.arc(cx,cy,br+8,sa,sa+.9);x.stroke();x.beginPath();x.arc(cx,cy,br+8,sa+3.14,sa+4.04);x.stroke()}}
 if(st==='count'){const el=Math.max(0,now-C.cs),bf=(el%C.beatMs)/C.beatMs,bi=Math.floor(el/C.beatMs);x.strokeStyle=th.amber;x.lineWidth=2;x.beginPath();x.arc(cx,cy,Rp,A0,A0+Math.min(1,(bi+bf)/3)*TAU);x.stroke();
  x.strokeStyle=rgba(th.amber,(1-bf)*.6);x.lineWidth=1.5;x.beginPath();x.arc(cx,cy,br+bf*R*.75,0,TAU);x.stroke();
  const num=Math.max(1,3-bi),sc=1+(1-Math.min(1,bf*4))*.22;x.save();x.translate(cx,cy);x.scale(sc,sc);x.globalAlpha=1-bf*.45;x.fillStyle=th.amber;x.font=`800 ${Math.round(R*.72)}px ${th.display}`;x.textAlign='center';x.textBaseline='middle';x.fillText(String(num),0,3);x.restore();x.globalAlpha=1}
}
function drawStrip(cv,C,now){const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,s=C.s,H=C.inHist,T=C.inTs,n=H.length,m=h/2,cnt=Math.min(n-1,Math.floor(w/2));x.clearRect(0,0,w,h);
 const oldT=T[(C.hi-1-cnt+n*2)%n]||now-cnt*16.7,dt=Math.max(4,(now-oldT)/cnt),Xt=tm=>w-(now-tm)/dt*2,rec=s.rec==='rec',x0=rec?Xt(C.recT0):w+1;
 if(rec){const bm=60000/s.bpm;for(let k=0;;k++){const tk=C.recT0+k*bm;if(tk>now)break;const px=Xt(tk);if(px<0)continue;x.fillStyle=rgba(th.ink,k%4?.07:.22);x.fillRect(Math.round(px),0,1,h)}x.fillStyle=rgba(th.accent,.06);x.fillRect(x0,0,w-x0,h)}
 for(let j=0;j<cnt;j++){const v=H[(C.hi-1-j+n*2)%n],px=w-j*2-2,hh=Math.max(.5,v*(m-4));x.fillStyle=rec&&px>=x0?(v>.8?th.accent:th.amber):rgba(th.ink,.28);x.fillRect(px,m-hh,1.4,hh*2)}
 if(rec){x.fillStyle=th.accent;x.fillRect(Math.round(x0),0,1,h)}x.fillStyle=rgba(th.ink,.08);x.fillRect(0,m,w,1);
 x.font=`600 9px ${th.mono}`;x.textBaseline='top';x.fillStyle=rec?th.accent:th.dim;x.fillText(rec?'● REC':'LIVE INPUT',6,5)}
function drawBoot(cv,C,now){const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,t=(now-(C.bootT0||now))/1000,p=clamp(C.bootP||0);x.clearRect(0,0,w,h);
 x.fillStyle=rgba(th.ink,.045);for(let gx=20;gx<w;gx+=40)for(let gy=20;gy<h;gy+=40)x.fillRect(gx,gy,1,1);
 const bg=x.createRadialGradient(w*.28,h*.5,0,w*.28,h*.5,w*.55);bg.addColorStop(0,rgba(th.accent,.06+p*.04));bg.addColorStop(1,rgba(th.accent,0));x.fillStyle=bg;x.fillRect(0,0,w,h);
 const sy=((t*.14)%1)*(h+160);const sg=x.createLinearGradient(0,sy-160,0,sy);sg.addColorStop(0,rgba(th.ink,0));sg.addColorStop(1,rgba(th.ink,.03));x.fillStyle=sg;x.fillRect(0,sy-160,w,160);
}
function drawFx(cv,C,now){
 const fx=C.fx;if(!cv)return;if(!fx){if(C.fxDirty){const P=prep(cv);P&&P.x.clearRect(0,0,P.w,P.h);C.fxDirty=false}return}
 const P=prep(cv);if(!P)return;const{x,w,h}=P,th=C.th,D=th.name==='dossier';C.fxDirty=true;
 const p=clamp((now-fx.t0)/(D?820:720));if(p>=.5&&!fx.sw){fx.sw=true;C.set({screen:fx.to})}
 const cover=p<.5?p/.5:1-(p-.5)/.5,ease=v=>v<.5?2*v*v:1-Math.pow(-2*v+2,2)/2,c=ease(cover),inn=p<.5;x.clearRect(0,0,w,h);
 const rh=D?30:3,rows=Math.ceil(h/rh);
 for(let r=0;r<rows;r++){const f=clamp((c*1.7-(r/rows)*.5-(D?0:(r%2)*.22))*1.6);if(f<=0)continue;const y=r*rh;const fw=w*f;const left=D?(r%2===0)===inn:inn;const x0=left?0:w-fw;x.fillStyle=D?'#050505':th.bg;x.fillRect(x0,y,fw,D?rh-2:rh);if(f<1){x.fillStyle=D?th.ink:th.accent;x.fillRect(left?x0+fw-2:x0,y,2,D?rh-2:rh)}}
 if(c>.85){x.globalAlpha=(c-.85)/.15;x.font=`700 12px ${th.mono}`;x.textAlign='center';x.fillStyle=D?th.ink:th.amber;x.fillText(D?`FILE ${fx.code} // ${fx.label}`:`ROUTING → ${fx.label}`,w/2,h/2);x.globalAlpha=1;x.textAlign='left'}
 if(p>=1){C.fx=null}
}

const VAULT=[['WE ARE GUY FVWKS | EXPECT *US*','PACT','Fenrir',140,'Am · 8A',4,-7.0,'Sep 24',['INTRO','DROP'],true],['NO NAMES. NO FACES. [0.5] ONLY *BASS*','LEGION','Michael',150,'Fm · 4A',8,-7.2,'Sep 22',['BUILD'],false],['REMEMBER | REMEMBER','ABYSS','Fenrir',140,'Am · 8A',2,-7.0,'Sep 21',['ID','INTRO'],true],['THIS IS NOT A DRILL','UNIT','Puck',145,'Em · 9A',4,-6.9,'Sep 19',['DROP'],false],['THE SIGNAL NEVER *DIES*','GHOST','George',138,'Dm · 7A',4,-7.1,'Sep 18',['OUTRO'],false],['WE ARE THE SIGNAL','SIGNAL','Heart',174,'Bm · 10A',2,-7.0,'Sep 15',['DNB'],true],['LIGHTS OFF | PHONES DOWN','PACT','Fenrir',140,'Am · 8A',4,-7.0,'Sep 12',['INTRO'],false],['YOU WERE *WARNED*','ABYSS','Michael',128,'Gm · 6A',8,-7.3,'Sep 09',['DROP','ID'],false]].map((r,i)=>({id:'v'+i,script:r[0],preset:r[1],voice:r[2],bpm:r[3],key:r[4],bars:r[5],lufs:r[6],date:r[7],tags:r[8],star:r[9]}));
const SETLIST=[['WE ARE GUY FVWKS','PACT','Fenrir',140,4],['NO NAMES. NO FACES.','LEGION','Michael',140,4],['REMEMBER | REMEMBER','ABYSS','Fenrir',140,2],['EXPECT *US*','PACT','Heart',140,1],['THE SIGNAL NEVER DIES','GHOST','George',140,4],['LIGHTS OFF | PHONES DOWN','UNIT','Puck',140,4]];
const LEX=[['FVWKS','Fawkes'],['GUY','Guy'],['DJ','dee jay'],['140','one forty']];
const mkWave=seed=>{const r=rng(seed);return Array.from({length:60},(_,i)=>clamp((.15+.85*Math.abs(nz(i*.33+seed%97)))*(nz(i*.11+seed%13)>-.4?1:.1)*(.6+r()*.4)))};
const wpath=w=>{const n=w.length,f=v=>v.toFixed(1),top=w.map((v,i)=>f(i/(n-1)*100)+','+f(10-Math.max(.4,v*9))),bot=w.map((v,i)=>f(i/(n-1)*100)+','+f(10+Math.max(.4,v*8))).reverse();return'M0,10 L'+top.join(' L')+' L'+bot.join(' L')+' Z'};
const mkTake=(id,n,dur)=>({id,n,dur,path:wpath(mkWave(hash(id)))});
const mmss=t=>String(Math.floor(t/60)).padStart(2,'0')+':'+(t%60).toFixed(2).padStart(5,'0');
function click(ac,out,t,hi){const o=ac.createOscillator(),g=ac.createGain();o.type='square';o.frequency.value=hi?1760:1175;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.18,t+.002);g.gain.exponentialRampToValueAtTime(.001,t+.07);o.connect(g).connect(out);o.start(t);o.stop(t+.09)}
const RAIL=[['studio','STUDIO','01'],['vault','VAULT','02'],['setlist','SETLIST','03'],['voices','VOICES','04'],['settings','SETTINGS','05']];

class Ctl{
 constructor(c,tn){
  this.c=c;this.th=THEMES[tn];this.tn=tn;this.D=tn==='dossier';
  this.s={screen:'studio',tab:'type',script:'WE ARE GUY FVWKS | EXPECT *US*',voice:'fenrir',speed:1,bpm:140,bpmText:'140',key:0,bars:'4',fmt:0,loud:'CLUB',k:{depth:.5,grit:.5,machine:.5,space:.5},typing:false,compact:false,sim:false,banner:null,analyzing:false,micDenied:false,tpForce:false,exporting:false,preset:'PACT',modified:false,user:[],stale:false,dirty:true,phase:null,playing:false,dry:false,loop:false,rackOpen:false,stretch:1,engine:'OFFLINE',booting:true,bootLines:[],bootPct:0,toast:null,cheat:false,keys:false,badge:false,tip:null,audition:null,rec:'idle',count:3,takes:[mkTake('t2','TAKE 02',6.86),mkTake('t1','TAKE 01',7.41)],activeTake:null,takePlaying:null,recDev:0,dropHot:false,finals:0,rendered:null,dragging:false};
  this.mods=RACKDEF.map(([name,params,na],i)=>({name,na:na||'',on:!na,open:i===1||i===3,adv:i===3,params:params.map(p=>({...p,v:p.def}))}));
  this.refs={};this._rf={};this._h={};this.sm=new Float32Array(96);this.lvl=0;this.beatPulse=0;this.lastBeat=-1;this.playT=null;this.taps=[];
  this.v={sel:{},star:Object.fromEntries(VAULT.map(r=>[r.id,r.star])),filter:'ALL',q:'',hover:null,playing:null,rer:'GHOST'};this.sl={name:'FOXBOX — FABRIC 10.05',lines:SETLIST.map((l,i)=>({id:'s'+i,script:l[0],preset:l[1],voice:l[2],bpm:l[3],bars:l[4],status:'QUEUED',p:0,err:''})),paste:false,pasteText:'',running:false};this.vo={model:'none',dl:0,desc:'Old radio preacher, slow, cavernous, a little broken',gen:'idle',cands:[],lex:LEX.map(([a,b])=>({a,b})),newA:'',newB:''};this.st={path:'~/Music/FoxBox',fmt:0,rate:'44.1',loud:'CLUB',club:'-7.0',bake:'-9.0',tp:'-1.0',pattern:'{artist}_{preset}_{slug}_{bpm}bpm_{bars}bar_{key}_{ab}_v{n}',artist:'GUY FVWKS',hot:true,mem:true,root:'/Users/guy/Music/FoxBox',out:0};this.modal=null;
  this.meter={st:-40,stMax:-40,tp:-40,tpHold:-40};this.raw={st:-60,pk:-60};
  this.onRef={banner:el=>{if(!RM)el.animate([{transform:'translate(-50%,-16px)',opacity:0,clipPath:'inset(0 0 100% 0)'},{opacity:1,offset:.45},{opacity:.35,offset:.55},{transform:'translate(-50%,0)',opacity:1,clipPath:'inset(0 0 0 0)'}],{duration:440,easing:'cubic-bezier(.2,.8,.2,1)'})},root:el=>{if(this.io)this.io.observe(el);if(this.ro)this.ro.observe(el)},toast:el=>{if(!RM)el.animate(this.D?[{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 0 0 0)'}]:[{opacity:0,transform:'translateY(14px)',clipPath:'inset(0 0 100% 0)'},{opacity:1,offset:.5},{opacity:.4,offset:.6},{opacity:1,transform:'none',clipPath:'inset(0 0 0 0)'}],{duration:420,easing:'cubic-bezier(.2,.8,.2,1)'})},drawer:el=>{if(!RM)el.animate([{clipPath:'inset(100% 0 0 0)',opacity:.4},{clipPath:'inset(0 0 0 0)',opacity:1}],{duration:460,easing:'cubic-bezier(.2,.8,.2,1)'});[...el.querySelectorAll('[data-mod]')].forEach((m,i)=>!RM&&m.animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:320,delay:120+i*28,fill:'backwards',easing:'cubic-bezier(.2,.8,.2,1)'}))}};
 }
 ref(n){return this._rf[n]||(this._rf[n]=el=>{this.refs[n]=el;if(el&&this.onRef[n])this.onRef[n](el)})}
 h(k,fn){return this._h[k]||(this._h[k]=fn)}
 set(p){Object.assign(this.s,p);this.c.forceUpdate()}
 mount(){this.kd=e=>this.onKey(e);window.addEventListener('keydown',this.kd);this.visible=true;
  this.io=new IntersectionObserver(es=>{this.visible=es[0].isIntersecting});if(this.refs.root)this.io.observe(this.refs.root);this.ro=new ResizeObserver(es=>{const c=es[0].contentRect.width<1420;if(c!==this.s.compact)this.set({compact:c})});if(this.refs.root)this.ro.observe(this.refs.root);
  const loop=now=>{this.raf=requestAnimationFrame(loop);if(this.visible)this.frame(now)};this.raf=requestAnimationFrame(loop);
  setTimeout(()=>this.boot(),60)}
 unmount(){cancelAnimationFrame(this.raf);window.removeEventListener('keydown',this.kd);clearInterval(this.bi);this.stopVoice();this.io&&this.io.disconnect();this.ro&&this.ro.disconnect();clearTimeout(this.rsT);clearTimeout(this.anT);if(this.ac)this.ac.close()}
 boot(){clearInterval(this.bi);this.stopVoice();this.set({booting:true,engine:'OFFLINE',bootLines:[],bootPct:0,phase:null,rackOpen:false,keys:false,sim:false});this.bootT0=performance.now();this.bootP=0;
  if(RM){this.set({booting:false,engine:'READY'});this.oldWave=null;this.computeWave();this.s.dirty=false;return}
  const L=BOOT[this.tn],th=this.th;let li=0,ci=0,pct=0,hold=6;const lines=[];
  this.bi=setInterval(()=>{const src=L[li];if(src===undefined){clearInterval(this.bi);setTimeout(()=>this.bootOut(),700);return}
   if(hold>0){hold--;return}
   ci=Math.min(src.length,ci+2);const full=ci>=src.length,last=li===L.length-1;let okT='';
   if(li===3&&full){pct=Math.min(100,pct+3);okT=pct<100?pct+'%':'[ OK ]'}else if(full)okT=last?'[ LIVE ]':'[ OK ]';
   if(!lines[li])this._lts=(performance.now()-this.bootT0)/1000;lines[li]={ts:'['+(lines[li]?lines[li].tsv:this._lts).toFixed(3).padStart(7,' ')+']',tsv:lines[li]?lines[li].tsv:this._lts,n:String(li+1).padStart(2,'0'),t:src.slice(0,ci),ok:!!okT,okT,okC:last?th.accent:th.amber,col:last?th.ink:rgba(th.ink,.78)};
   this.bootP=(li+(li===3?(ci/src.length)*.3+pct/100*.7:ci/src.length))/L.length;
   this.set({bootLines:lines.map((o,i)=>({...o,cursor:i===lines.length-1&&!o.ok})),engine:li<2?'OFFLINE':li<7?'LOADING MODEL':'READY',bootPct:li<3?0:pct});
   if(full&&(li!==3||pct>=100)){li++;ci=0;hold=5}},16)}
 bootOut(){const el=this.refs.boot;this.set({engine:'READY'});this.reveal(160);
  if(!el){this.set({booting:false});this.render(false,true);return}
  const a=el.animate(this.D?[{clipPath:'inset(0 0 0 0)'},{clipPath:'inset(0 0 0 100%)'}]:[{clipPath:'inset(0 0 0 0)',filter:'brightness(1)'},{clipPath:'inset(49.6% 0 49.6% 0)',filter:'brightness(2.4)',offset:.72},{clipPath:'inset(50% 50% 50% 50%)',filter:'brightness(3)'}],{duration:this.D?620:560,easing:'cubic-bezier(.7,0,.2,1)',fill:'forwards'});
  a.onfinish=()=>{this.set({booting:false});this.render(false,true)}}
 reveal(delay){const root=this.refs.root;if(!root||RM)return;const els=[...root.querySelectorAll('[data-reveal]')].sort((a,b)=>a.dataset.reveal-b.dataset.reveal);
  els.forEach((el,i)=>el.animate(this.D?[{opacity:0,clipPath:'inset(0 100% 0 0)'},{opacity:1,clipPath:'inset(0 0% 0 0)'}]:[{opacity:0,clipPath:'inset(0 0 100% 0)',transform:'translateY(8px)'},{opacity:.8,offset:.35},{opacity:.2,offset:.5},{opacity:1,offset:.62},{opacity:1,clipPath:'inset(0 0 0% 0)',transform:'none'}],{duration:this.D?520:680,delay:delay+i*75,easing:'cubic-bezier(.2,.7,.2,1)',fill:'backwards'}));
  [...root.querySelectorAll('[data-redact]')].forEach((el,i)=>el.animate([{transform:'scaleX(1)'},{transform:'scaleX(0)'}],{duration:420,delay:delay+500+i*55,easing:'cubic-bezier(.7,0,.2,1)',fill:'backwards'}))}
 geom(){const s=this.r||this.s,len=this.len||1,bpm=clamp(s.bpm||140,60,200),barDur=240/bpm;let barCount,target;if(s.bars==='FREE'){barCount=Math.max(1,Math.ceil(len/barDur));target=len}else{barCount=+s.bars;target=barCount*barDur}return{len,target,barCount,barDur,viewLen:Math.max(barCount*barDur,len)*1.03}}
 computeWave(){const s=this.s,est=estimate(s.script,s.speed),len=est*s.stretch;this.sched=buildSchedule(s.script,len,hash(s.script+s.voice));this.len=this.sched.len;
  const E=this.eff();this.r={bpm:s.bpm,bars:s.bars,k:E,voice:s.voice,loud:s.loud,dry:s.dry};
  this.oldWaveDry=this.waveDry;this.wave=waveData(this.sched,this.len,E,false,900,s.loud);this.bands=bandData(this.sched,this.len,E,false,900);this.bandsDry=bandData(this.sched,this.len,E,true,900);this.waveDry=waveData(this.sched,this.len,E,true,900,s.loud);this.miniDirty=true}
 base(){return this.presetVals(this.s.preset)||PRESETS.PACT}
 eff(){const b=this.base(),m=this.s.k,o={};for(const id in m){const v=m[id],bb=b[id];o[id]=v<.5?bb*v*2:bb+(1-bb)*(v-.5)*2}return o}
 stats(){const s=this.r||this.s,k=s.k;const club=s.loud==='CLUB';const lufs=club?-7.0:-9.6+k.grit*3;const tp=club?-1.0-(k.space*.1):-2.4+k.grit*2.8;return{lufs,tp:this.s.tpForce?0.4:tp,target:club?-7:-9}}
 render(final,initial){if(this.s.phase||(this.s.booting&&!initial))return;if(this.s.engine==='OFFLINE'||this.s.engine==='RESTARTING')return;
  const go=()=>{const mode=(final||initial||this.s.dirty)?'reveal':'morph';this.oldWave=this.wave;this.computeWave();this.sweepP=0;this.sweep={t0:performance.now(),dur:RM?1:mode==='morph'?420:final?1150:initial?1000:720,final,mode};this.set({phase:final?'FINAL RENDER':'PREVIEW RENDER',engine:mode==='morph'?this.s.engine:'BUSY'})};
  if(this.s.dirty&&!RM){this.set({phase:'SYNTHESIZING',engine:'BUSY'});setTimeout(go,initial?500:750)}else go()}
 finishRender(){const f=this.sweep.final;this.sweep=null;this.oldWave=null;const st=this.stats();const p={phase:null,engine:'READY',stale:false,dirty:false,rendered:{final:f},analyzing:true};if(f)p.finals=this.s.finals+1;this.set(p);clearTimeout(this.anT);this.anT=setTimeout(()=>this.set({analyzing:false}),RM?10:1500);
  if(this.refs.prog)this.refs.prog.style.width='0%';
  if(f){this.eject();this.toast(this.D?'TRANSMISSION PRINTED':'FINAL RENDER COMPLETE',`${st.lufs.toFixed(1)} LUFS · ${st.tp.toFixed(1)} dBTP · drag the cartridge into Rekordbox`)}
  if(this.pendingExport){this.pendingExport=false;setTimeout(()=>this.exportFile(),400)}}
 eject(){const el=this.refs.cart;if(!el||RM)return;el.animate(this.D?[{transform:'translateY(-18px) rotate(-2deg)',opacity:0},{transform:'translateY(2px) rotate(.4deg)',opacity:1,offset:.7},{transform:'none'}]:[{transform:'translateX(30px)',opacity:0,clipPath:'inset(0 0 0 100%)'},{opacity:1,offset:.4},{opacity:.3,offset:.5},{opacity:1,transform:'translateX(-3px)',clipPath:'inset(0 0 0 0)',offset:.8},{transform:'none'}],{duration:640,easing:'cubic-bezier(.2,.8,.2,1)'})}
 toast(title,body){clearTimeout(this.tt);this.set({toast:{title,body}});this.tt=setTimeout(()=>this.set({toast:null}),3800)}
 markStale(auto){this.s.stale=true;this.c.forceUpdate();if(auto){clearTimeout(this.at);this.at=setTimeout(()=>this.render(false),auto)}}
 ensureAudio(){if(!this.ac){const AC=window.AudioContext||window.webkitAudioContext;this.ac=new AC();this.an=this.ac.createAnalyser();this.an.fftSize=1024;this.an.smoothingTimeConstant=.6;this.out=this.ac.createGain();this.out.gain.value=.7;this.out.connect(this.an);this.an.connect(this.ac.destination);this.buf=new Float32Array(1024);this.bins=new Uint8Array(512)}if(this.ac.state==='suspended')this.ac.resume()}
 startVoice(){this.ensureAudio();if(!this.sched)this.computeWave();const v=VOICES.find(q=>q.id===(this.r||this.s).voice)||VOICES[0];this.voice&&this.voice.stop();this.t0=this.ac.currentTime+.05;this.voice=synth(this.ac,this.out,this.sched,{t0:this.t0,f0:v.f0,k:(this.r||this.s).k,dry:this.s.dry});this.playLen=this.geom().target;this.lastBeat=-1;this.raw.stMax=-60;this.raw.pkMax=-60;this.meter.stMax=-40;this.meter.tpHold=-40}
 stopVoice(){this.voice&&this.voice.stop();this.voice=null;this.playT=null;if(this.s.playing)this.set({playing:false})}
 togglePlay(){if(this.s.playing){this.stopVoice();return}if(this.s.booting)return;this.startVoice();this.set({playing:true})}
 audition(id){this.ensureAudio();const v=VOICES.find(q=>q.id===id);this.audV&&this.audV.stop();const sch=buildSchedule('WE ARE GUY FVWKS',1.8,hash(id));this.audV=synth(this.ac,this.out,sch,{t0:this.ac.currentTime+.03,f0:v.f0,k:this.eff(),dry:false});this.aud=true;this.set({audition:id});clearTimeout(this.adt);this.adt=setTimeout(()=>{this.aud=false;this.set({audition:null})},2000)}
 frame(now){const s=this.s;this.applyFrame();if(this.exp){const p=clamp((now-this.exp.t0)/(RM?1:950));if(this.refs.exp)this.refs.exp.style.width=(p*100)+'%';if(p>=1){this.exp=null;if(this.refs.exp)this.refs.exp.style.width='0%';this.set({exporting:false});this.toast('EXPORTED',`~/Music/FoxBox/${this.fileName()}`)}}
  if(s.playing&&this.ac){let t=this.ac.currentTime-this.t0;if(t>this.playLen+.05){if(s.loop){this.startVoice();t=0}else{this.stopVoice();t=null}}this.playT=t}else this.playT=null;
  let rms=0,pk=0;if(this.an&&(s.playing||this.aud)){this.an.getFloatTimeDomainData(this.buf);for(const v of this.buf){rms+=v*v;pk=Math.max(pk,Math.abs(v))}rms=Math.sqrt(rms/this.buf.length);this.an.getByteFrequencyData(this.bins)}
  const L=clamp(rms*5);this.lvl+=(L-this.lvl)*(L>this.lvl?.5:.08);
  if(s.playing){const st=this.stats(),rd=20*Math.log10(rms+1e-6),pd=20*Math.log10(pk+1e-6);this.raw.st+=(rd-this.raw.st)*(rd>this.raw.st?.25:.04);this.raw.stMax=Math.max(this.raw.stMax,this.raw.st);this.raw.pkMax=Math.max(this.raw.pkMax,pd);
   const m=this.meter;m.st=st.lufs+(this.raw.st-this.raw.stMax);m.stMax=Math.max(m.stMax,m.st);const tp=st.tp+(pd-this.raw.pkMax);m.tp+=(tp-m.tp)*(tp>m.tp?.6:.1);if(m.tp>m.tpHold||now-(this.tph||0)>1000){if(m.tp>m.tpHold)this.tph=now;m.tpHold=m.tp>m.tpHold?m.tp:m.tpHold-.08}}
  if(this.playT!=null&&this.playT>=0){const b=Math.floor(this.playT/(60/(this.r||s).bpm));if(b!==this.lastBeat){this.lastBeat=b;this.beatPulse=1;this.leds(b%4)}}else if(this.lastBeat!==-2){this.lastBeat=-2;this.leds(-1)}
  this.beatPulse*=.9;
  if(this.refs.mark)this.refs.mark.style.opacity=String(.65+this.beatPulse*.35);
  if(this.refs.time){const t=this.playT!=null?Math.max(0,this.playT):0;this.refs.time.textContent=`${f2(t).padStart(5,'0')} / ${f2(this.geom().target)}`}
  if(this.refs.engDot){this.refs.engDot.style.opacity=s.engine==='READY'?String(.75+.25*Math.sin(now/600)):String(.35+.65*(Math.floor(now/140)%2))}
  if(this.sweep){this.sweepP=clamp((now-this.sweep.t0)/this.sweep.dur);if(this.refs.prog&&this.sweep.final)this.refs.prog.style.width=(this.sweepP*100)+'%';if(this.sweepP>=1)this.finishRender()}
  {const tg=(s.stale&&!this.sweep)||s.phase==='SYNTHESIZING'?1:0;this.stMix=(this.stMix||0)+(tg-(this.stMix||0))*(RM?1:.16)}drawWave(this.refs.wave,this,now);drawCore(this.refs.core,this,now/1000);drawMeter(this.refs.meter,this);
  if(this.miniDirty&&this.refs.mini){drawMini(this.refs.mini,this);this.miniDirty=false}
  if(this.refs.recOrb||this.s.rec!=='idle')this.recFrame(now);drawFx(this.refs.fx,this,now);if(s.booting)this.bootFrame(now)}
 leds(i){const el=this.refs.beat;if(!el)return;[...el.children].forEach((c,j)=>{c.style.background=j===i?(j===0?this.th.accent:this.th.amber):rgba(this.th.ink,.18);c.style.boxShadow=j===i&&!this.D?`0 0 8px ${j===0?this.th.accent:this.th.amber}`:'none'})}
 setK(id,v){this.s.k={...this.s.k,[id]:clamp(v)};this.s.modified=true;this.markStale()}
 tweenK(to,then){const from={...this.s.k},t0=performance.now(),d=RM?1:420;const step=()=>{const p=clamp((performance.now()-t0)/d),e=1-Math.pow(1-p,3),k={};for(const id in to)k[id]=from[id]+(to[id]-from[id])*e;this.s.k=k;this.c.forceUpdate();if(p<1)requestAnimationFrame(step);else then&&then()};step()}
 presetVals(n){return PRESETS[n]||(this.s.user.find(u=>u.name===n)||{}).k}
 applyPreset(n){if(!this.presetVals(n))return;this.set({preset:n,modified:false,stale:true});this.tweenK({depth:.5,grit:.5,machine:.5,space:.5},()=>this.render(false))}
 savePreset(){const n=`USER ${this.s.user.length+1}`;const E=this.eff();this.s.k={depth:.5,grit:.5,machine:.5,space:.5};this.set({user:[...this.s.user,{name:n,k:E}],preset:n,modified:false});this.toast('PRESET SAVED',`${n} · stored in presets/user`)}
 exportFile(){if(!this.s.finals){this.pendingExport=true;this.render(true);return}if(this.exp)return;this.exp={t0:performance.now()};this.set({exporting:true})}
 nav(id){if(id===this.s.screen||this.fx||this.s.booting)return;const r=RAIL.find(q=>q[0]===id);if(RM){this.set({screen:id});return}this.fx={t0:performance.now(),to:id,label:r[1],code:r[2]}}
 fileName(){const s=this.s;const slug=s.script.replace(/\[[0-9.]+\]|[|*]/g,' ').toLowerCase().match(/[a-z0-9]+/g)||['untitled'];const ext=FORMATS[s.fmt].startsWith('WAV')?'wav':'aiff';return`GUYFVWKS_${(s.preset||'CUSTOM').replace(/\s/g,'')}_${slug.slice(0,4).join('-')}_${s.bpm}bpm_${s.bars==='FREE'?'free':s.bars+'bar'}_${KEYS[s.key].split(' ')[0].replace('#','s')}_${s.dry?'dry':'wet'}_v${String(Math.max(1,s.finals)).padStart(2,'0')}.${ext}`}
 onKey(e){if(VB.active!==this||this.s.booting)return;const mod=e.metaKey||e.ctrlKey,key=e.key,typing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if(mod&&key==='Enter'){e.preventDefault();this.render(true);return}if(mod&&key.toLowerCase()==='e'){e.preventDefault();this.exportFile();return}if(mod&&key.toLowerCase()==='s'){e.preventDefault();this.savePreset();return}
  if(typing||mod)return;
  if(key===' '){e.preventDefault();this.togglePlay()}else if(key==='\\')this.toggleAB();else if(key.toLowerCase()==='l')this.set({loop:!this.s.loop});else if(/^[1-7]$/.test(key))this.applyPreset(PNAMES[+key-1]);else if(key.toLowerCase()==='r'&&this.s.screen==='studio'&&this.s.tab==='record'&&!this.s.micDenied)this.toggleRec();else if(key==='?')this.set({keys:!this.s.keys});else if(key==='Escape')this.set({keys:false,cheat:false,rackOpen:false})}
 toggleAB(){const was=this.s.playing;this.set({dry:!this.s.dry});if(was){const t=this.playT;this.startVoice()}}
 knob(id){const H=this.h.bind(this);return{
  onDown:H('kd'+id,e=>{e.preventDefault();const el=e.currentTarget;el.focus();let y=e.clientY;this.set({tip:id});this.stopVoice();
   const mv=ev=>{const f=ev.shiftKey?.0012:.0055;this.setK(id,this.s.k[id]+(y-ev.clientY)*f);y=ev.clientY};const up=()=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);this.set({tip:null});this.render(false)};window.addEventListener('pointermove',mv);window.addEventListener('pointerup',up)}),
  onReset:H('kr'+id,()=>{this.tweenK({...this.s.k,[id]:.5},()=>this.render(false))}),
  onWheel:H('kw'+id,e=>{this.setK(id,this.s.k[id]-Math.sign(e.deltaY)*(e.shiftKey?.005:.02));this.set({tip:id});clearTimeout(this.wt);this.wt=setTimeout(()=>{this.set({tip:null});this.render(false)},450)}),
  onKey:H('kk'+id,e=>{const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key];if(d){e.preventDefault();e.stopPropagation();this.setK(id,this.s.k[id]+d*(e.shiftKey?.005:.02));clearTimeout(this.wt);this.wt=setTimeout(()=>this.render(false),450)}else if(e.key==='Home'||e.key==='End'){e.preventDefault();this.setK(id,e.key==='End'?1:0)}}),
  onFocus:H('kf'+id,()=>this.set({tip:id})),onBlur:H('kb'+id,()=>{if(this.s.tip===id)this.set({tip:null})})}}
 toggleRec(){const s=this.s;if(s.rec==='rec')return this.stopRec();if(s.rec==='count')return this.set({rec:'idle'});this.ensureAudio();const beat=60/s.bpm,t=this.ac.currentTime+.05;for(let i=0;i<3;i++)click(this.ac,this.out,t+i*beat,i===0);this.cs=performance.now()+50;this.beatMs=beat*1000;this.set({rec:'count',count:3})}
 startRec(){this.recT0=performance.now();this.recBuf=[];this.set({rec:'rec'})}
 stopRec(){const d=(performance.now()-this.recT0)/1000,src=this.recBuf||[],N=60,id='t'+Date.now(),n=this.s.takes.length+1;const w=Array.from({length:N},(_,i)=>{const a=Math.floor(i/N*src.length),b=Math.max(a+1,Math.floor((i+1)/N*src.length));let m=0;for(let j=a;j<b&&j<src.length;j++)m=Math.max(m,src[j]);return m});
  this.set({rec:'idle',takes:[{id,n:'TAKE '+String(n).padStart(2,'0'),dur:d,path:wpath(w)},...this.s.takes],activeTake:id});
  if(!RM)requestAnimationFrame(()=>{const el=this.refs.root&&this.refs.root.querySelector('[data-take="'+id+'"]');el&&el.animate([{opacity:0,transform:'translateY(-8px)',clipPath:'inset(0 100% 0 0)'},{opacity:1,offset:.5},{opacity:.4,offset:.6},{opacity:1,transform:'none',clipPath:'inset(0 0 0 0)'}],{duration:560,easing:'cubic-bezier(.2,.8,.2,1)'})})}
 recFrame(now){const s=this.s;let L;
  if(s.rec==='count'){const el=now-this.cs,c=3-Math.floor(Math.max(0,el)/this.beatMs);if(el>=3*this.beatMs)this.startRec();else if(c!==s.count&&c>=1)this.set({count:c})}
  if(this.s.rec==='rec'){const t=(now-this.recT0)/1000;L=clamp((.18+.72*Math.abs(nz(t*7.3)))*(nz(t*1.4)>-.35?1:.1)+Math.random()*.06);this.recBuf.push(L);const tg=s.bars==='FREE'?0:+s.bars*240/s.bpm;if(tg&&t>=tg)this.stopRec()}
  else L=.02+Math.random()*.02+(s.rec==='count'?.01:0);
  this.inLvl=(this.inLvl||0)+(L-(this.inLvl||0))*.5;if(!this.inHist){this.inHist=new Float32Array(720);this.inTs=new Float64Array(720);this.hi=0}this.inHist[this.hi]=this.inLvl;this.inTs[this.hi]=now;this.hi=(this.hi+1)%720;this.inPk=Math.max(this.inLvl,(this.inPk||0)-.006);
  const tr=this.refs.recTime;if(tr){if(this.s.rec==='rec'){const t=(now-this.recT0)/1000,bd=240/s.bpm;tr.textContent=mmss(t)+'  ·  BAR '+(Math.floor(t/bd)+1)+'.'+(Math.floor((t%bd)/(bd/4))+1)}else tr.textContent=this.s.rec==='count'?'COUNT-IN':'00:00.00'}
  drawOrb(this.refs.recOrb,this,now);drawStrip(this.refs.recStrip,this,now);drawRec(this.refs.recm,this)}
 recVals(){const s=this.s,H=this.h.bind(this),th=this.th,ink=th.ink,st=s.rec;return{
  recBig:st==='count'?'':st==='rec'?'STOP':'REC',recHint:st==='idle'?'CLICK · R':'',recAria:st==='rec'?'Stop recording':'Start recording',recFg:st==='rec'?th.bg:th.accent,
  recLabel:st==='idle'?'COUNT-IN 3 BEATS @ '+s.bpm+' · '+(s.bars==='FREE'?'FREE LENGTH':'AUTO-STOP AT '+s.bars+' BARS'):st==='count'?'GET READY':'RECORDING · CLICK TO STOP',recLabelC:st==='rec'?th.accent:st==='count'?th.amber:th.dim,
  recOrbRef:this.ref('recOrb'),recStripRef:this.ref('recStrip'),recRef:this.ref('recm'),recTimeRef:this.ref('recTime'),
  recDevice:['MacBook Pro Microphone','Audio Interface (UR22C) · In 1','AirPods Pro'][s.recDev||0],onRecDevice:H('rdev',()=>this.set({recDev:((this.s.recDev||0)+1)%3})),onRec:H('rec',()=>this.toggleRec()),
  takesCount:String(s.takes.length),hasTakes:s.takes.length>0,noTakes:!s.takes.length,onClearTakes:H('rclr',()=>this.set({takes:[],activeTake:null})),
  takes:s.takes.map(tk=>{const act=s.activeTake===tk.id,pl=s.takePlaying===tk.id;return{id:tk.id,n:tk.n,dur:tk.dur.toFixed(2)+'s',path:tk.path,waveC:act?th.amber:rgba(ink,.45),border:act?rgba(th.amber,.45):rgba(ink,.08),bg:act?rgba(th.amber,.05):'transparent',playT:pl?'■':'▶',useT:act?'✓ IN USE':'USE',useBg:act?th.amber:'transparent',useFg:act?th.bg:ink,useBorder:act?th.amber:rgba(ink,.2),
   onUse:H('tu'+tk.id,()=>{this.set({activeTake:tk.id,dirty:true});this.toast(tk.n+' → SOURCE','Masking with '+this.s.preset+' · '+tk.dur.toFixed(2)+' s');this.markStale(400)}),
   onPlay:H('tp'+tk.id,()=>{this.rowV&&this.rowV.stop();if(this.s.takePlaying===tk.id)return this.set({takePlaying:null});this.ensureAudio();this.set({takePlaying:tk.id});const sch=buildSchedule('WE ARE GUY FVWKS | EXPECT US',tk.dur,hash(tk.id));this.rowV=synth(this.ac,this.out,sch,{t0:this.ac.currentTime+.03,f0:110,k:{depth:0,grit:0,machine:0,space:0},dry:true});clearTimeout(this.tpT);this.tpT=setTimeout(()=>this.set({takePlaying:null}),tk.dur*1000+300)})}})}}
 bootFrame(now){const e0=now-(this.bootT0||now),G='ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#/%';
  const sc=(el,tg,st,du)=>{if(!el)return;const e=clamp((e0-st)/du),n=Math.floor(e*tg.length);if(e>=1){if(el.textContent!==tg)el.textContent=tg;return}if(now-(el._t||0)<48)return;el._t=now;let o='';for(let i=0;i<tg.length;i++)o+=i<n?tg[i]:G[Math.floor(Math.random()*G.length)];el.textContent=o};
  sc(this.refs.bootTitle,'FOXBOX',180,1150);sc(this.refs.bootSub,'VOICE MASK',760,900);
  if(this.refs.bootClock)this.refs.bootClock.textContent='T+'+mmss(e0/1000);if(this.refs.bootBar)this.refs.bootBar.style.transform='scaleX('+clamp(this.bootP||0)+')';
  drawBoot(this.refs.bootCv,this,now)}
 applyFrame(){const f=this.c.props&&this.c.props.frame,r=this.refs.root;if(!r||f===this._fr)return;this._fr=f;const m={'1512 × 982':['1512px','982px'],'1280 × 800':['1280px','800px']}[f]||['100%','100vh'];r.style.width=m[0];r.style.height=m[1]}
 animBody(i){if(RM)return;requestAnimationFrame(()=>{const el=this.refs.drawer&&this.refs.drawer.querySelector('[data-mod="'+i+'"] [data-body]');el&&el.animate([{clipPath:'inset(0 0 100% 0)',opacity:.3},{clipPath:'inset(0 0 0 0)',opacity:1}],{duration:320,easing:'cubic-bezier(.2,.8,.2,1)'})})}
 pv(p,i,j){const H=this.h.bind(this),th=this.th,ink=th.ink,n=clamp((p.v-p.min)/(p.max-p.min)),opt=p.options,K=p.kind,k=i+'_'+j;
  const fmt=v=>{const a=p.step<1?Math.abs(v).toFixed(p.step<.1?2:1):String(Math.round(Math.abs(v)));return(v<0?'−':'')+a+(p.unit?(p.unit[0]===':'?p.unit:' '+p.unit):'')};
  const set=v=>{p.v=Math.round(clamp(v,p.min,p.max)/p.step)*p.step;this.markStale()},commit=()=>this.markStale(300);
  return{label:p.label,adv:p.adv,valT:opt?opt[p.v]:K==='switch'?(p.v?'ON':'OFF'):fmt(p.v),w:(K==='knob'||K==='number')?'calc(50% - 5px)':'100%',isKnob:K==='knob',isFader:K==='fader',isSwitch:K==='switch',isSelect:K==='select',isSeg:K==='segmented',isNum:K==='number',
   fill:(n*100)+'%',dash:(70.69*n).toFixed(2)+' 200',rot:'rotate('+(-135+270*n).toFixed(1)+'deg)',swBg:p.v?th.amber:rgba(ink,.14),swX:p.v?'translateX(18px)':'none',swA:p.v?'true':'false',labelC:p.adv?th.amber:th.dim,
   segs:(K==='segmented'?opt:[]).map((o,q)=>({label:o,bg:p.v===q?ink:'transparent',fg:p.v===q?th.bg:th.dim,onClick:H('ps'+k+'_'+q,()=>{p.v=q;commit()})})),
   onKnob:H('pk'+k,e=>{e.preventDefault();let y=e.clientY;const mv=ev=>{set(p.v+(y-ev.clientY)*(ev.shiftKey?.001:.005)*(p.max-p.min));y=ev.clientY};const up=()=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);commit()};window.addEventListener('pointermove',mv);window.addEventListener('pointerup',up)}),
   onFader:H('pf'+k,e=>{const el=e.currentTarget,f=ev=>{const r=el.getBoundingClientRect();set(p.min+clamp((ev.clientX-r.left)/r.width)*(p.max-p.min))};f(e);const up=()=>{window.removeEventListener('pointermove',f);window.removeEventListener('pointerup',up);commit()};window.addEventListener('pointermove',f);window.addEventListener('pointerup',up)}),
   onSwitch:H('pw'+k,()=>{p.v=p.v?0:1;commit()}),onCycle:H('pc'+k,()=>{p.v=(p.v+1)%opt.length;commit()}),onDec:H('pd'+k,()=>{set(p.v-p.step);commit()}),onInc:H('pi'+k,()=>{set(p.v+p.step);commit()})}}
 restart(){this.stopVoice();this.set({engine:'RESTARTING',banner:{kind:'info',title:'ENGINE RESTARTING',body:'Respawning TTS worker · reloading kokoro-82m · 13 DSP modules',action:null}});clearTimeout(this.rsT);this.rsT=setTimeout(()=>{this.set({engine:'READY',banner:null});this.toast('ENGINE READY','Worker pid 4502 · model warm · 0.8 s')},RM?50:2400)}
 bannerAct(){const a=this.s.banner&&this.s.banner.action;if(a==='RECONNECT')return this.restart();this.set({banner:null});if(a==='RETRY'){this.s.dirty=true;this.render(false)}else if(a==='APPLY LIMITER'){this.set({tpForce:false});this.markStale(10)}else if(a==='SWAP TO GEORGE'){this.mods[2].params[4].v=2;this.toast('STACK VOICE → GEORGE','Re-rendering the layer');this.markStale(10)}else if(a==='REVEAL EXPORTS')this.toast('REVEALED IN FINDER','~/Music/FoxBox · 212 files · 18.4 GB')}
 simDefs(){if(this._sims)return this._sims;const st=p=>this.set({screen:'studio',...p});return this._sims=[
  ['First run / boot',()=>this.boot()],
  ['Empty studio',()=>{st({tab:'type',script:'',dirty:true});this.markStale()}],
  ['Stale while editing',()=>{st({});this.setK('grit',this.s.k.grit>.8?.3:this.s.k.grit+.2)}],
  ['Synthesizing → preview',()=>{st({});this.s.dirty=true;this.render(false)}],
  ['Final render',()=>{st({});this.render(true)}],
  ['Exporting',()=>{st({});this.exportFile()}],
  ['Analysis pending',()=>{st({});this.render(false)}],
  ['Engine offline',()=>{this.stopVoice();this.set({engine:'OFFLINE',banner:{kind:'err',title:'ENGINE OFFLINE',body:'TTS worker stopped responding (pid 4471). Your script and rack are safe.',action:'RECONNECT'}})}],
  ['Engine restarting',()=>this.restart()],
  ['TTS / render error',()=>{st({phase:'SYNTHESIZING',engine:'BUSY',stale:true});setTimeout(()=>this.set({phase:null,engine:'READY',banner:{kind:'err',title:'SYNTHESIS FAILED',body:'Voice “Fenrir” returned empty audio for segment 3 (“*US*”). Other segments OK.',action:'RETRY'}}),900)}],
  ['Stack voice failed',()=>this.set({banner:{kind:'err',title:'STACK VOICE FAILED',body:'LAYERS → STACK VOICE “Heart” returned no audio. Main voice rendered; the stack is muted.',action:'SWAP TO GEORGE'}})],
  ['Fit overflow',()=>{st({tab:'type',script:'WE ARE GUY FVWKS | WE DO NOT FORGIVE [0.5] WE DO NOT FORGET | EXPECT *US*',bars:'2',stretch:1,dirty:true});this.markStale(10)}],
  ['True-peak warning',()=>this.set({tpForce:true,banner:{kind:'warn',title:'TRUE PEAK +0.4 dBTP',body:'Over the −1.0 dBTP ceiling. Club systems will clip on the throw.',action:'APPLY LIMITER'}})],
  ['Mic permission denied',()=>st({tab:'record',micDenied:true})],
  ['Low disk (< 3 GB)',()=>this.set({banner:{kind:'warn',title:'LOW DISK · 2.4 GB FREE',body:'Final renders and the persona model need at least 3 GB on Macintosh HD.',action:'REVEAL EXPORTS'}})],
  ['Batch partial failure',()=>{this.nav('setlist');setTimeout(()=>this.renderAll(),900)}]]}
 extraVals(){const s=this.s,H=this.h.bind(this),th=this.th,b=s.banner,U=s.user,actU=U.find(q=>q.name===s.preset),pidx=PNAMES.indexOf(s.preset);
  const cells=PNAMES.map((n,i)=>({name:n,n:String(i+1).padStart(2,'0'),sel:pidx===i?'true':'false',fg:pidx===i?th.ink:th.dim,edited:pidx===i&&s.modified,onClick:H('pcf'+n,()=>this.applyPreset(n))}));
  cells.push({name:actU?actU.name:U.length?U[U.length-1].name:'EMPTY',n:U.length?'USER · '+U.length:'USER',sel:actU?'true':'false',fg:actU?th.ink:th.dim,edited:!!actU&&s.modified,onClick:H('pcu',()=>{const L=this.s.user;if(!L.length)return this.savePreset();const a=L.findIndex(q=>q.name===this.s.preset);this.applyPreset(L[a<0?L.length-1:(a+1)%L.length].name)})});
  return{presetCells:cells,presetX:'translateX('+((actU?7:Math.max(0,pidx))*100)+'%)',compact:s.compact,notCompact:!s.compact,notTyping:!s.typing,isEmpty:!s.script.trim(),exportLabel:s.exporting?'EXPORTING…':'EXPORT',expRef:this.ref('exp'),
  simOpen:s.sim,toggleSim:H('tsim',()=>this.set({sim:!this.s.sim})),sims:this.simDefs().map(([l,f],i)=>({label:l,n:String(i+1).padStart(2,'0'),onClick:H('sim'+i,()=>{this.set({sim:false,keys:false});f()})})),
  hasBanner:!!b,bannerTitle:b?b.title:'',bannerBody:b?b.body:'',bannerAction:b&&b.action?b.action:'',hasBannerAction:!!(b&&b.action),bannerCol:b?{err:th.accent,warn:th.amber,info:th.ink}[b.kind]:th.ink,bannerIcon:b?{err:'✕',warn:'!',info:'↻'}[b.kind]:'',isRestarting:s.engine==='RESTARTING',
  onBannerAction:H('ba',()=>this.bannerAct()),onBannerClose:H('bc',()=>this.set({banner:null})),bannerRef:this.ref('banner')}}
 vals(){
  const s=this.s,th=this.th,D=this.D,H=this.h.bind(this),ink=th.ink,dim=th.dim;
  const est=estimate(s.script,s.speed),len=est*s.stretch,isF=s.bars==='FREE',nb=+s.bars,target=isF?len:nb*240/s.bpm,diff=len-target,ratio=target/est;
  const bi=BARS.indexOf(s.bars),up=!isF&&bi<4?BARS[bi+1]:null,down=!isF&&bi>0?BARS[bi-1]:null;let fit;
  if(isF)fit={state:'FREE',icon:'◇',verdict:'Grid follows the speech length',chips:[],col:dim};
  else if(Math.abs(diff)/target<.015)fit={state:'LOCKED',icon:'✓',verdict:`Sits on ${nb} bars exactly`,chips:s.stretch!==1?[{label:'RESET STRETCH',a:'r'}]:[],col:ink};
  else if(diff>0){const over=ratio<.85;fit={state:over?'OVERFLOW':'OVER',icon:over?'!':'▲',verdict:over?`Overflows by ${f2(diff)} s`:`STRETCH ${f2(ratio)}× or go ${up||nb} BARS`,chips:[...(ratio>=.8?[{label:`STRETCH ${f2(ratio)}×`,a:'s',v:ratio}]:[]),...(up?[{label:`GO ${up} BARS`,a:'b',v:up}]:[])],col:over?th.accent:th.amber}}
  else fit={state:'SHORT',icon:'▼',verdict:`${f2(-diff)} s of air · STRETCH ${f2(ratio)}× or pad tail`,chips:[...(ratio<=1.2?[{label:`STRETCH ${f2(ratio)}×`,a:'s',v:ratio}]:[]),...(down&&est<=+down*240/s.bpm*1.02?[{label:`GO ${down} BARS`,a:'b',v:down}]:[])],col:ink};
  const fitChips=fit.chips.map((c,i)=>({label:c.label,onClick:()=>{if(c.a==='s')this.set({stretch:c.v});else if(c.a==='b')this.set({bars:c.v,stretch:1});else this.set({stretch:1});this.markStale(10)}}));
  const EF=this.eff(),k=s.dry?{depth:0,grit:0,machine:0,space:0}:EF,sc=k.depth*.38+k.machine*.3+k.grit*.2+k.space*.12,lvI=sc<.1?0:sc<.28?1:sc<.5?2:3,lvl=['SYNTHETIC','WEAK','MEDIUM','STRONG'][lvI];
  const reasons=[];if(k.depth>.3)reasons.push(`Pitch ${(-k.depth*9).toFixed(1)} st hides the fundamental`);if(k.depth>.3)reasons.push(`Formant ${(-k.depth*4).toFixed(1)} breaks timbre ID`);if(k.machine>.3)reasons.push(`Ring mod ${Math.round(30+k.machine*60)} Hz masks prosody`);if(k.grit>.4)reasons.push('Crush removes breath detail');if(k.space>.5)reasons.push('Diffuse tail smears onsets');if(lvI<2)reasons.push(lvI===0?'Near-raw TTS: reads as a synthetic voice':'Raise DEPTH or MACHINE for anonymity');
  const st=this.stats(),tpWarn=st.tp>-1.0+.01;const busy=!!s.phase,eng=s.engine;
  const engineLabel=eng==='LOADING MODEL'?`LOADING MODEL ${s.bootPct}%`:eng==='BUSY'?(s.phase||'BUSY'):eng;
  const engineColor=eng==='READY'?(D?ink:'#7fd08a'):eng==='OFFLINE'?th.accent:th.amber;
  const allP=[...PNAMES.map((n,i)=>({name:n,n:String(i+1)})),...s.user.map(u=>({name:u.name,n:'U'}))];
  const modFill=D?ink:th.amber;
  return{
   rootRef:this.ref('root'),activate:H('act',()=>{VB.active=this}),fxRef:this.ref('fx'),markRef:this.ref('mark'),
   booting:s.booting,bootRef:this.ref('boot'),bootLines:s.bootLines,bootCvRef:this.ref('bootCv'),bootTitleRef:this.ref('bootTitle'),bootSubRef:this.ref('bootSub'),bootClockRef:this.ref('bootClock'),bootBarRef:this.ref('bootBar'),bootSegs:Array.from({length:40},(_,i)=>{const on=i<Math.round(s.bootPct/2.5);return{bg:on?(i>=37?th.accent:th.amber):rgba(ink,.08),sh:on?'0 0 6px '+rgba(i>=37?th.accent:th.amber,.6):'none'}}),bootPct:`${s.bootPct}%`,bootBar:`${s.bootPct}%`,replayBoot:H('rb',()=>this.boot()),
   engineLabel,engineColor,engDotRef:this.ref('engDot'),
   bpmText:s.bpmText,onBpmInput:H('bi',e=>{this.set({bpmText:e.target.value.replace(/[^0-9.]/g,'').slice(0,5)})}),
   onBpmBlur:H('bb',()=>{const v=Math.round(clamp(parseFloat(s.bpmText)||s.bpm,60,200));this.set({bpm:v,bpmText:String(v)});this.markStale(300)}),
   onBpmKey:H('bk',e=>{if(e.key==='Enter')e.target.blur();if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const v=clamp(this.s.bpm+(e.key==='ArrowUp'?1:-1),60,200);this.set({bpm:v,bpmText:String(v)});this.markStale(500)}}),
   onTap:H('tap',()=>{const n=performance.now();this.taps=this.taps.filter(t=>n-t<2200);this.taps.push(n);this.leds((this.taps.length-1)%4);if(this.taps.length>=3){const iv=[];for(let i=1;i<this.taps.length;i++)iv.push(this.taps[i]-this.taps[i-1]);const b=Math.round(60000/(iv.reduce((a,c)=>a+c,0)/iv.length));if(b>=60&&b<=200){this.set({bpm:b,bpmText:String(b)});this.markStale(900)}}}),
   beatRef:this.ref('beat'),
   keyIdx:String(s.key),keys:KEYS.map((l,i)=>({label:l,value:String(i)})),onKey:H('key',e=>{this.set({key:+e.target.value})}),
   bars:BARS.map(b=>({label:b,onClick:H('bar'+b,()=>{this.set({bars:b,stretch:1});this.markStale(250)}),bg:s.bars===b?ink:'transparent',fg:s.bars===b?th.bg:dim})),
   fmtLabel:FORMATS[s.fmt],onFmt:H('fmt',()=>this.set({fmt:(this.s.fmt+1)%FORMATS.length})),
   loudLabel:s.loud,onLoud:H('loud',()=>{this.set({loud:this.s.loud==='CLUB'?'BAKE-IN':'CLUB'});this.markStale(250)}),
   renderLabel:s.phase==='SYNTHESIZING'?'SYNTH…':s.phase==='FINAL RENDER'?'RENDERING':'RENDER',onRenderFinal:H('rf',()=>this.render(true)),progRef:this.ref('prog'),
   rail:RAIL.map(([id,label,n])=>({id,label,n,onClick:H('nav'+id,()=>this.nav(id)),fg:s.screen===id?ink:dim,bar:s.screen===id?th.accent:'transparent',cur:s.screen===id?'page':'false'})),
   isStudio:s.screen==='studio',notStudio:s.screen!=='studio',screenTitle:(RAIL.find(r=>r[0]===s.screen)||RAIL[0])[1],screenCode:(RAIL.find(r=>r[0]===s.screen)||RAIL[0])[2],
   tabs:['TYPE','RECORD','IMPORT'].map(t=>({label:t,onClick:H('tab'+t,()=>this.set({tab:t.toLowerCase()})),fg:s.tab===t.toLowerCase()?ink:dim,line:s.tab===t.toLowerCase()?th.accent:'transparent',sel:s.tab===t.toLowerCase()?'true':'false'})),
   isType:s.tab==='type',isRecord:s.tab==='record'&&!s.micDenied,isMicDenied:s.tab==='record'&&s.micDenied,onOpenPrivacy:H('opp',()=>{this.set({micDenied:false});this.toast('MICROPHONE ALLOWED','System Settings → Privacy & Security → Microphone → VoiceBox')}),isImport:s.tab==='import',
   typing:s.typing,onScriptFocus:H('sf',()=>this.set({typing:true})),onScriptBlur:H('sb',()=>this.set({typing:false})),script:s.script,onScript:H('scr',e=>{this.set({script:e.target.value,dirty:true});this.markStale(1300)}),tokens:tokenize(s.script),charCount:`${s.script.length} CH · ${f2(est)} S`,
   cheat:s.cheat,toggleCheat:H('ch',()=>this.set({cheat:!this.s.cheat})),
   voices:VOICES.map(v=>({id:v.id,name:v.name,nameU:v.name.toUpperCase(),desc:v.desc,tags:v.tags.map(t=>({t})),active:s.voice===v.id?'true':'false',border:s.voice===v.id?(D?ink:th.amber):rgba(ink,.1),bg:s.voice===v.id?rgba(D?ink:th.amber,.07):'transparent',dot:s.voice===v.id?th.accent:rgba(ink,.2),
    onClick:H('v'+v.id,()=>{if(this.s.voice!==v.id){this.set({voice:v.id,dirty:true});this.markStale(300)}}),onAud:H('va'+v.id,e=>{e.stopPropagation();this.audition(v.id)}),audLabel:s.audition===v.id?'■ 2S':'▶ 2S'})),
   speedLabel:`${s.speed.toFixed(2)}×`,speedFill:`${(s.speed-.8)/.4*100}%`,
   onSpeedDown:H('spd',e=>{const el=e.currentTarget,set=ev=>{const r=el.getBoundingClientRect();const v=Math.round((.8+clamp((ev.clientX-r.left)/r.width)*.4)*100)/100;this.set({speed:v,dirty:true,stale:true})};set(e);const up=()=>{window.removeEventListener('pointermove',set);window.removeEventListener('pointerup',up);this.markStale(200)};window.addEventListener('pointermove',set);window.addEventListener('pointerup',up)}),
   ...this.recVals(),
   dropBorder:s.dropHot?th.accent:rgba(ink,.18),dropBg:s.dropHot?rgba(th.accent,.06):'transparent',
   onDragOver:H('dov',e=>{e.preventDefault();if(!this.s.dropHot)this.set({dropHot:true})}),onDragLeave:H('dlv',()=>this.set({dropHot:false})),
   onDrop:H('drp',e=>{e.preventDefault();const f=e.dataTransfer.files&&e.dataTransfer.files[0];this.set({dropHot:false});this.toast('IMPORTED',f?f.name:'Audio file queued for masking')}),
   waveRef:this.ref('wave'),coreRef:this.ref('core'),meterRef:this.ref('meter'),timeRef:this.ref('time'),
   status:s.phase?s.phase:s.stale?'STALE · RELEASE TO RENDER':'',hasStatus:!(this.sweep&&this.sweep.mode==='morph')&&!!(s.phase||s.stale),statusColor:s.phase?th.amber:dim,
   playLabel:s.playing?'■ STOP':'▶ PLAY',onPlay:H('play',()=>this.togglePlay()),playBg:s.playing?th.accent:'transparent',playFg:s.playing?th.bg:ink,
   aBg:s.dry?ink:'transparent',aFg:s.dry?th.bg:dim,bBg:s.dry?'transparent':ink,bFg:s.dry?dim:th.bg,onAB:H('ab',()=>this.toggleAB()),
   loopBg:s.loop?th.amber:'transparent',loopFg:s.loop?th.bg:dim,onLoop:H('loop',()=>this.set({loop:!this.s.loop})),
   fitState:fit.state,fitIcon:fit.icon,fitVerdict:fit.verdict,fitCol:fit.col,fitChips,hasChips:fitChips.length>0,
   fitLine:`SPEECH ${f2(est)}s${s.stretch!==1?` ×${f2(s.stretch)}`:''} → ${isF?'FREE':nb+' BARS'} @ ${s.bpm} = ${f2(target)}s`,noChips:!fitChips.length,fitDelta:isF?'':`${diff>=0?'+':'−'}${f2(Math.abs(diff))} s`,fitFill:`${Math.min(len/target,1)*80}%`,fitOver:`${Math.min(Math.max(0,len/target-1)*80,20)}%`,fitTicks:isF?[]:Array.from({length:Math.max(0,nb-1)},(_,i)=>({l:`${(i+1)/nb*80}%`})),
   maskPending:s.analyzing,maskLevel:s.analyzing?'ANALYZING':lvl,maskSegs:[0,1,2,3].map(i=>({bg:s.analyzing?rgba(ink,.12):i<=lvI&&lvI>0?(lvI===3?th.accent:D?ink:th.amber):rgba(ink,.12)})),maskReasons:reasons.map(r=>({r})),badge:s.badge,
   onBadgeIn:H('bin',()=>this.set({badge:true})),onBadgeOut:H('bout',()=>this.set({badge:false})),
   tpWarn,tpText:`TRUE PEAK ${st.tp>0?'+':''}${st.tp.toFixed(1)} dBTP > −1.0`,
   presets:allP.map(p=>({name:p.name,n:p.n,onClick:H('p'+p.name,()=>this.applyPreset(p.name)),bg:s.preset===p.name?(D?ink:rgba(th.accent,.14)):'transparent',fg:s.preset===p.name?(D?th.bg:ink):dim,border:s.preset===p.name?(D?ink:th.accent):rgba(ink,.12)})),
   presetName:`${s.preset||'CUSTOM'}${s.modified?' *':''}`,savePreset:H('sp',()=>this.savePreset()),
   knobs:KNOBS.map(kn=>{const v=s.k[kn.id],ev=EF[kn.id],mv=mapVals(kn.id,ev),am=[ev,clamp(ev*1.15-.08),clamp(ev*.75)];const tr=[254.47,278.03,301.59];
    return{id:kn.id,label:kn.label,pct:String(Math.round(v*100)).padStart(2,'0'),now:Math.round(v*100),valText:`${kn.label} ${Math.round(v*100)} percent`,dash:`${(207.35*v).toFixed(2)} 600`,rot:`rotate(${(-135+270*v).toFixed(1)}deg)`,tip:s.tip===kn.id,atDefault:Math.abs(v-.5)<.005,
     maps:kn.maps.map((l,i)=>({label:l,val:mv[i],r:54+i*5,track:`${tr[i]} 600`,dash:`${(tr[i]*am[i]).toFixed(2)} 600`,op:String(.35+i*-.08+am[i]*.5)})),...this.knob(kn.id)}}),
   rackOpen:s.rackOpen,openRack:H('or',()=>this.set({rackOpen:true})),closeRack:H('cr',()=>{const el=this.refs.drawer;if(el&&!RM){el.animate([{clipPath:'inset(0 0 0 0)'},{clipPath:'inset(100% 0 0 0)'}],{duration:300,easing:'cubic-bezier(.7,0,.8,.3)'}).onfinish=()=>this.set({rackOpen:false})}else this.set({rackOpen:false})}),drawerRef:this.ref('drawer'),
   modules:this.mods.map((m,i)=>{const ps=m.params.map((p,j)=>this.pv(p,i,j)),advN=m.params.filter(p=>p.adv).length;return{i:String(i),name:m.name,n:String(i+1).padStart(2,'0'),op:m.on?'1':'.5',isNa:!!m.na,na:m.na,open:m.open,closed:!m.open,chev:m.open?'−':'+',border:m.open?rgba(th.amber,.35):rgba(ink,.08),summary:ps.filter(p=>!p.adv).slice(0,3).map(p=>p.label+' '+p.valT).join(' · '),shown:ps.filter(p=>!p.adv||m.adv),hasAdv:advN>0,advLabel:m.adv?'− HIDE ADVANCED':'+ ADVANCED · '+advN,swBg:m.on?th.amber:rgba(ink,.14),swX:m.on?'translateX(14px)':'none',swA:m.on?'true':'false',
    onToggle:H('mt'+i,e=>{e.stopPropagation();if(m.na){this.toast(m.name+' NOT AVAILABLE',m.na);return}m.on=!m.on;this.markStale(300)}),onOpen:H('mo'+i,()=>{m.open=!m.open;this.up();if(m.open)this.animBody(i)}),onAdv:H('ma'+i,()=>{m.adv=!m.adv;this.up()})}}),
   cartRef:this.ref('cart'),miniRef:this.ref('mini'),fileName:this.fileName(),cartDur:`${f2(this.geom().target)} s`,cartBpm:`${(this.r||s).bpm}`,cartKey:KEYS[s.key],cartLufs:`${st.lufs.toFixed(1)}`,cartTp:`${st.tp.toFixed(1)}`,
   cartTag:s.finals?`FINAL v${String(s.finals).padStart(2,'0')}`:'PREVIEW',cartTagBg:s.finals?th.accent:'transparent',cartTagFg:s.finals?th.bg:dim,cartOp:s.dragging?'.5':'1',
   onExport:H('ex',()=>this.exportFile()),onReveal:H('rv',()=>this.toast('REVEALED IN FINDER','~/Music/FoxBox')),onSetlist:H('sl',()=>this.toast('ADDED TO SETLIST','Line 01 · '+(s.preset||'CUSTOM')+' · '+s.bpm+' BPM')),
   onCartDrag:H('cd',e=>{e.dataTransfer.setData('text/plain',this.fileName());e.dataTransfer.effectAllowed='copy';this.set({dragging:true})}),onCartDragEnd:H('cde',()=>this.set({dragging:false})),
   toast:s.toast,hasToast:!!s.toast,toastTitle:s.toast?s.toast.title:'',toastBody:s.toast?s.toast.body:'',toastRef:this.ref('toast'),
   keysOpen:s.keys,toggleKeys:H('tk',()=>this.set({keys:!this.s.keys})),shortcuts:SHORTCUTS.map(([k,a])=>({k,a})),
   serial:'TRANSMISSION #0042',...this.extraVals(),...this.screenVals()
  }}
 up(){this.c.forceUpdate()}
 playScript(script,preset,voice,id,done){this.ensureAudio();this.rowV&&this.rowV.stop();const len=estimate(script,1),sch=buildSchedule(script,len,hash(script+voice)),v=VOICES.find(q=>q.name===voice)||VOICES[0];this.rowV=synth(this.ac,this.out,sch,{t0:this.ac.currentTime+.03,f0:v.f0,k:PRESETS[preset]||PRESETS.PACT,dry:false});clearTimeout(this.rvt);this.rvt=setTimeout(()=>{done&&done()},(sch.len+.4)*1000)}
 openInStudio(r){this.set({script:r.script,preset:r.preset,k:{depth:.5,grit:.5,machine:.5,space:.5},bpm:r.bpm,bpmText:String(r.bpm),bars:String(r.bars),voice:(VOICES.find(q=>q.name===r.voice)||VOICES[0]).id,dirty:true,stale:true,modified:false,stretch:1});this.nav('studio');setTimeout(()=>this.render(false),900)}
 renderAll(){const L=this.sl.lines;if(this.sl.running)return;L.forEach(l=>{if(l.status!=='DONE'){l.status='QUEUED';l.p=0;l.err=''}});this.sl.running=true;this.up();let i=L.findIndex(l=>l.status==='QUEUED');const step=()=>{if(i<0||i>=L.length){this.sl.running=false;const f=L.filter(l=>l.status==='FAILED').length;this.toast(f?'SETLIST PARTIAL':'SETLIST RENDERED',f?`${L.length-f} of ${L.length} rendered · ${f} failed — retry or change voice`:`${L.length} files · ready to export`);return}const l=L[i];if(l.status==='DONE'){i++;return step()}l.status='RENDERING';const t=setInterval(()=>{l.p=Math.min(1,l.p+.07+Math.random()*.05);if(l.voice==='Heart'&&l.p>.55&&!l.retried){clearInterval(t);l.status='FAILED';l.err='TTS: stack voice Heart failed to synthesize';i++;this.up();setTimeout(step,200);return}if(l.p>=1){clearInterval(t);l.status='DONE';i++;this.up();setTimeout(step,150);return}this.up()},55)};step()}
 screenVals(){const H=this.h.bind(this),th=this.th,ink=th.ink,dim=th.dim,V=this.v,S=this.sl,VO=this.vo,ST=this.st,s=this.s;const cyc=(arr,v)=>arr[(arr.indexOf(v)+1)%arr.length];
  const rows=VAULT.filter(r=>{const f=V.filter;if(f==='★ STARRED'&&!V.star[r.id])return false;if(PRESETS[f]&&r.preset!==f)return false;if(f==='140 BPM'&&r.bpm!==140)return false;if(V.q&&!r.script.toLowerCase().includes(V.q.toLowerCase()))return false;return true});
  const nSel=Object.values(V.sel).filter(Boolean).length;
  const tag=st=>({QUEUED:[dim,'transparent'],RENDERING:[th.amber,'transparent'],DONE:[th.bg,ink],FAILED:[th.bg,th.accent]}[st]);
  const done=S.lines.filter(l=>l.status==='DONE').length,failed=S.lines.filter(l=>l.status==='FAILED').length;
  return{isVault:s.screen==='vault',isSetlist:s.screen==='setlist',isVoices:s.screen==='voices',isSettings:s.screen==='settings',
   vQuery:V.q,onVQuery:H('vq',e=>{V.q=e.target.value;this.up()}),
   vFilters:['ALL','★ STARRED','PACT','LEGION','ABYSS','140 BPM'].map(f=>({label:f,onClick:H('vf'+f,()=>{V.filter=f;this.up()}),bg:V.filter===f?ink:'transparent',fg:V.filter===f?th.bg:dim,border:V.filter===f?ink:rgba(ink,.16)})),
   vCount:`${rows.length} OF ${VAULT.length} TRANSMISSIONS`,
   vRows:rows.map(r=>{const sel=!!V.sel[r.id],hov=V.hover===r.id,pl=V.playing===r.id;return{...r,bpmKey:`${r.bpm} · ${r.key.split(' ')[0]} · ${r.bars} BAR`,lufsT:r.lufs.toFixed(1),tagsL:r.tags.map(t=>({t})),
    selMark:sel?'■':'',selBorder:sel?th.amber:rgba(ink,.3),rowBg:sel?rgba(th.amber,.06):hov?rgba(ink,.03):'transparent',
    redact:hov?'scaleX(0)':'scaleX(1)',starT:V.star[r.id]?'★':'☆',starC:V.star[r.id]?th.amber:dim,playT:pl?'■':'▶',playC:pl?th.accent:ink,
    onSel:H('vs'+r.id,e=>{e.stopPropagation();V.sel[r.id]=!V.sel[r.id];this.up()}),onStar:H('vst'+r.id,e=>{e.stopPropagation();V.star[r.id]=!V.star[r.id];this.up()}),
    onEnter:H('ve'+r.id,()=>{V.hover=r.id;this.up()}),onLeave:H('vl'+r.id,()=>{if(V.hover===r.id){V.hover=null;this.up()}}),
    onPlay:H('vp'+r.id,e=>{e.stopPropagation();if(V.playing===r.id){this.rowV&&this.rowV.stop();V.playing=null;this.up();return}V.playing=r.id;this.up();this.playScript(r.script,r.preset,r.voice,r.id,()=>{V.playing=null;this.up()})}),
    onOpen:H('vo'+r.id,e=>{e.stopPropagation();this.openInStudio(r)}),onDrag:H('vd'+r.id,e=>{e.dataTransfer.setData('text/plain',`GUYFVWKS_${r.preset}_${r.bpm}bpm.aiff`)})}}),
   vNone:rows.length===0,vHasSel:nSel>0,vSelLabel:`${nSel} SELECTED`,vRer:V.rer,onVRer:H('vrr',()=>{V.rer=cyc(PNAMES,V.rer);this.up()}),
   onVExport:H('vex',()=>{this.modal={title:'REKORDBOX XML EXPORTED',body:`Playlist “FOXBOX — VAULT” · ${nSel||rows.length} tracks`,steps:['Rekordbox → Preferences → Advanced → Database → rekordbox xml: point to ~/Music/FoxBox/rekordbox.xml','Open the rekordbox xml tree in the browser sidebar','Right-click “FOXBOX — VAULT” → Import Playlist. Hot cue A sits on the first word.']};this.up()}),
   onVRerender:H('vrn',()=>{this.toast('RE-RENDER QUEUED',`${nSel} files → ${V.rer} · runs in Setlist`);V.sel={};this.up()}),onVClear:H('vcl',()=>{V.sel={};this.up()}),
   slName:S.name,onSlName:H('sln',e=>{S.name=e.target.value;this.up()}),
   slLines:S.lines.map((l,i)=>{const [fg,bg]=tag(l.status);return{...l,n:String(i+1).padStart(2,'0'),statusT:l.status==='RENDERING'?`RENDERING ${Math.round(l.p*100)}%`:l.status,sFg:fg,sBg:bg,sBorder:l.status==='QUEUED'?rgba(ink,.2):l.status==='RENDERING'?th.amber:bg,prog:`${l.p*100}%`,progBg:l.status==='FAILED'?th.accent:th.amber,isFailed:l.status==='FAILED',barsT:`${l.bars} BAR`,
    onPreset:H('slp'+l.id,()=>{l.preset=cyc(PNAMES,l.preset);l.status='QUEUED';l.p=0;this.up()}),onVoice:H('slv'+l.id,()=>{l.voice=cyc(VOICES.map(v=>v.name),l.voice);l.status='QUEUED';l.p=0;l.err='';this.up()}),onBars:H('slb'+l.id,()=>{l.bars=cyc([1,2,4,8,16],l.bars);l.status='QUEUED';l.p=0;this.up()}),
    onRetry:H('slr'+l.id,()=>{l.retried=true;l.status='QUEUED';l.p=0;l.err='';this.up();this.renderAll()}),onDel:H('sld'+l.id,()=>{S.lines=S.lines.filter(q=>q!==l);this.up()})}}),
   slSummary:`${S.lines.length} LINES · ${done} DONE${failed?` · ${failed} FAILED`:''}`,slFailed:failed>0,slRunning:S.running,slRenderLabel:S.running?'RENDERING…':'RENDER ALL',
   onSlRender:H('slra',()=>this.renderAll()),slPaste:S.paste,slPasteText:S.pasteText,onSlPasteToggle:H('slpt',()=>{S.paste=!S.paste;this.up()}),onSlPasteText:H('slptx',e=>{S.pasteText=e.target.value;this.up()}),
   onSlPasteAdd:H('slpa',()=>{const add=S.pasteText.split('\n').map(t=>t.trim()).filter(Boolean);add.forEach((t,j)=>S.lines.push({id:'s'+Date.now()+j,script:t,preset:'PACT',voice:'Fenrir',bpm:140,bars:4,status:'QUEUED',p:0,err:''}));S.pasteText='';S.paste=false;this.up();this.toast('LINES ADDED',`${add.length} lines queued`)}),
   onSlExport:H('slex',()=>{this.modal={title:'FOLDER + REKORDBOX XML EXPORTED',body:`~/Music/FoxBox/Setlists/${S.name} · ${done} files`,steps:['Rekordbox → Preferences → Advanced → rekordbox xml: select the exported rekordbox.xml',`In the sidebar open rekordbox xml → “${S.name}”`,'Right-click → Import Playlist. Memory cue marks each tail.']};this.up()}),
   voiceCards:VOICES.map(v=>({...v,nameU:v.name.toUpperCase(),tagsL:v.tags.map(t=>({t})),f0T:`${v.f0} Hz`,isDef:v.id===s.voice,audLabel:s.audition===v.id?'■ PLAYING':'▶ AUDITION',onAud:H('vca'+v.id,()=>this.audition(v.id))})),
   voModelNone:VO.model==='none',voModelDl:VO.model==='dl',voModelReady:VO.model==='ready',voDl:`${Math.round(VO.dl*100)}%`,voDlW:`${VO.dl*100}%`,voDlMb:`${(VO.dl*1.9).toFixed(2)} / 1.90 GB`,
   onVoDownload:H('vodl',()=>{VO.model='dl';this.up();const t=setInterval(()=>{VO.dl=Math.min(1,VO.dl+.018+Math.random()*.02);if(VO.dl>=1){clearInterval(t);VO.model='ready';this.toast('PERSONA MODEL READY','1.9 GB installed · 39.3 GB free')}this.up()},60)}),
   voDesc:VO.desc,onVoDesc:H('vod',e=>{VO.desc=e.target.value;this.up()}),voGenIdle:VO.gen==='idle',voGenBusy:VO.gen==='busy',voGenDone:VO.gen==='done',
   onVoGen:H('vog',()=>{VO.gen='busy';this.up();setTimeout(()=>{const r=rng(hash(VO.desc));VO.cands=['A','B','C'].map((l,i)=>({l,name:`PERSONA ${l}`,f0:Math.round(80+r()*60),trait:['CAVERNOUS · SLOW','BROKEN · WARM','THIN · DISTANT'][i],match:`${Math.round(92-i*7-r()*4)}%`}));VO.gen='done';this.up()},1600)}),
   voCands:VO.cands.map(c=>({...c,f0T:`${c.f0} Hz`,onAud:H('vcd'+c.l,()=>{this.ensureAudio();const sch=buildSchedule('WE ARE GUY FVWKS',1.8,hash(c.name));this.aud=true;synth(this.ac,this.out,sch,{t0:this.ac.currentTime+.03,f0:c.f0,k:this.eff(),dry:false});setTimeout(()=>this.aud=false,2000)}),onSave:H('vcs'+c.l,()=>this.toast('PERSONA SAVED',`${c.name} added to installed voices`))})),
   lex:VO.lex.map((e,i)=>({...e,onDel:H('lxd'+i+e.a,()=>{VO.lex=VO.lex.filter(q=>q!==e);this.up()})})),lexA:VO.newA,lexB:VO.newB,onLexA:H('lxa',e=>{VO.newA=e.target.value.toUpperCase();this.up()}),onLexB:H('lxb',e=>{VO.newB=e.target.value;this.up()}),
   onLexAdd:H('lxadd',()=>{if(!VO.newA.trim()||!VO.newB.trim())return;VO.lex=[...VO.lex,{a:VO.newA.trim(),b:VO.newB.trim()}];VO.newA='';VO.newB='';this.up()}),
   stPath:ST.path,onStPath:H('stp',()=>{ST.path='~/Music/FoxBox/Exports';this.up();this.toast('EXPORT FOLDER',ST.path)}),
   stFormats:FORMATS.map((f,i)=>({label:f,value:String(i)})),stFmt:String(ST.fmt),onStFmt:H('stf',e=>{ST.fmt=+e.target.value;this.s.fmt=ST.fmt;this.up()}),
   stRates:['44.1','48','96'].map(r=>({label:r+' kHz',onClick:H('str'+r,()=>{ST.rate=r;this.up()}),bg:ST.rate===r?ink:'transparent',fg:ST.rate===r?th.bg:dim})),
   stLouds:['CLUB','BAKE-IN'].map(r=>({label:r,onClick:H('stl'+r,()=>{ST.loud=r;this.s.loud=r;this.up()}),bg:s.loud===r?ink:'transparent',fg:s.loud===r?th.bg:dim})),
   stClub:ST.club,stBake:ST.bake,stTp:ST.tp,onStClub:H('stc',e=>{ST.club=e.target.value;this.up()}),onStBake:H('stb',e=>{ST.bake=e.target.value;this.up()}),onStTp:H('stt',e=>{ST.tp=e.target.value;this.up()}),
   stPattern:ST.pattern,onStPattern:H('stpa',e=>{ST.pattern=e.target.value;this.up()}),stArtist:ST.artist,onStArtist:H('sta',e=>{ST.artist=e.target.value;this.up()}),stPreview:this.fileName(),
   stHot:ST.hot,stMem:ST.mem,hotBg:ST.hot?th.amber:rgba(ink,.14),hotX:ST.hot?'translateX(18px)':'none',memBg:ST.mem?th.amber:rgba(ink,.14),memX:ST.mem?'translateX(18px)':'none',onStHot:H('sth',()=>{ST.hot=!ST.hot;this.up()}),onStMem:H('stm',()=>{ST.mem=!ST.mem;this.up()}),hotA:ST.hot?'true':'false',memA:ST.mem?'true':'false',
   stRoot:ST.root,onStRoot:H('stro',()=>this.toast('TARGET ROOT',ST.root)),stOuts:['MacBook Pro Speakers','Pioneer DJM-A9 USB','Audio Interface (UR22C)'].map((o,i)=>({label:o,value:String(i)})),stOut:String(ST.out),onStOut:H('sto',e=>{ST.out=+e.target.value;this.up()}),
   hasModal:!!this.modal,modalTitle:this.modal?this.modal.title:'',modalBody:this.modal?this.modal.body:'',modalSteps:this.modal?this.modal.steps.map((t,i)=>({t,n:String(i+1).padStart(2,'0')})):[],onModalClose:H('mc',()=>{this.modal=null;this.up()}),onModalStop:H('mst',e=>e.stopPropagation())}}
}
window.VB={controller:(c,t)=>new Ctl(c,t),active:null,RM};
})();
