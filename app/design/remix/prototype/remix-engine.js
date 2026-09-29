// REMIX prototype data + pure helpers (no UI). Loaded by Remix.dc.html.
(function(){
const INK='#e9e5da',DIM='#8d8a82',EMB='#ff4b2b',AMB='#ffb23e',ICE='#7cc8ff',OKC='#7fd08a',BG='#0b0b0c',ROSE='#e79bd0';
const SC={INTRO:['#9aa3b5','154,163,181'],BUILD:['#d9c46a','217,196,106'],DROP:['#ff4b2b','255,75,43'],BREAK:['#6fc2b0','111,194,176'],OUTRO:['#8f86a8','143,134,168']};
const T={
 nightshift:{id:'nightshift',title:'NIGHTSHIFT',bpm:140,key:'C#m',cam:'12A',bars:144,len:'4:07',style:'DUBSTEP'},
 hollow:{id:'hollow',title:'HOLLOW POINT',bpm:144,key:'Bm',cam:'10A',bars:144,len:'4:00',style:'DUBSTEP'},
 ironlung:{id:'ironlung',title:'IRON LUNG',bpm:140,key:'D#m',cam:'2A',bars:128,len:'3:39',style:'DEEP'},
 subterra:{id:'subterra',title:'SUBTERRA',bpm:150,key:'C#m',cam:'12A',bars:160,len:'4:16',style:'DUBSTEP'},
 ratking:{id:'ratking',title:'RAT KING',bpm:70,key:'F#m',cam:'11A',bars:72,len:'4:07',style:'TRAP'},
 glass:{id:'glass',title:'GLASS TEETH',bpm:138,key:'Cm',cam:'5A',bars:136,len:'3:56',style:'DEEP'},
 warden:{id:'warden',title:'WARDEN',bpm:142,key:'Gm',cam:'6A',bars:144,len:'4:03',style:'DUBSTEP'},
 static:{id:'static',title:'STATIC PRAYER',bpm:140,key:'Fm',cam:'4A',bars:152,len:'4:21',style:'DEEP'}};
const LIB=['nightshift','hollow','ironlung','subterra','ratking','glass','warden','static'];
const MATCH={hollow:{st:2,tr:.97,sc:86},ironlung:{st:-2,tr:1,sc:81},subterra:{st:0,tr:.93,sc:74},glass:{st:1,tr:1.01,sc:63},ratking:{st:-5,tr:1,sc:58},warden:{st:6,tr:.99,sc:34,far:true},static:{st:-4,tr:1,sc:52},nightshift:{st:0,tr:1,sc:70}};
const RADAR=[['hollow',['key +2 st','tempo 0.97×','bass style match','fills the gap']],['ironlung',['key −2 st','tempo 1.00×','bass style match']],['subterra',['same key','tempo 0.93×','fills the gap']],['glass',['key +1 st','tempo 1.01×']],['ratking',['half-time fit','key −5 st']]];
const PTABS=['TEAROUT','RIDDIM','808','WOBBLE','REESE','GROWL'];
const PATCH={
 TEAROUT:[['chomp','CHOMP','FOXBOX'],['talker','TALKER','FOXBOX'],['disperser','DISPERSER','FOXBOX'],['dive','DIVE','FOXBOX'],['pwm','PWM RESO','FOXBOX'],['metal','METAL','FOXBOX']],
 RIDDIM:[['wub','WUB','FOXBOX'],['yoi','YOI','FOXBOX'],['square','RIDDIM SQUARE','SURGE'],['chain','CHAIN RIDDIM','FOXBOX'],['stab','SUB STAB','FOXBOX']],
 '808':[['line808','808 LINE','FOXBOX'],['darkhit','DARK HIT','FOXBOX'],['boom','BOOM 808','FOXBOX'],['dist','DIST 808','FOXBOX'],['g808','GLIDE 808','SURGE']],
 WOBBLE:[['wubc','WUB CLASSIC','SURGE'],['yoyo','TRIPLET YOYO','SURGE'],['lazer','LAZER WOB','FOXBOX'],['tapewob','TAPE WOBBLE','FOXBOX']],
 REESE:[['hreese','HOLLOW REESE','SURGE'],['tunnel','TUNNEL REESE','SURGE'],['neuro','NEURO REESE','FOXBOX'],['sawpair','DARK SAW PAIR','SURGE']],
 GROWL:[['cave','CAVE GROWL','SURGE'],['yawn','VOWEL YAWN','SURGE'],['jaw','METAL JAW','FOXBOX']]};
const TOPS=[['arp','ARP'],['powerup','POWER-UP'],['coin','COIN']];
const PNAME={},PFAM={};Object.entries(PATCH).forEach(([f,l])=>l.forEach(([id,n])=>{PNAME[id]=n;PFAM[id]=f;}));
const FLIPS=[{id:'traphy',name:'TRAP-HYBRID',bpm:'140 · HELD 808',tempo:140,k:[0,7,10],s:[8]},{id:'riddim',name:'RIDDIM',bpm:'150',tempo:150,k:[0,6,10],s:[8]},{id:'half',name:'HALF-TIME',bpm:'70 / 140',tempo:140,k:[0,10],s:[8]},{id:'d140',name:'140 DUBSTEP',bpm:'140',tempo:140,k:[0,14],s:[8]},{id:'four',name:'FOUR-ON-THE-FLOOR',bpm:'128',tempo:128,k:[0,4,8,12],s:[4,12]},{id:'dnb',name:'DNB',bpm:'174',tempo:174,k:[0,10],s:[4,12]}];
const KITS=[['fox','FOXBOX KIT','layered kick · clap-led snare'],['808a','TR-808 · DRY','1994'],['808b','TR-808 · LONG BOOM','1994'],['808c','TR-808 · HOT TAPE','1994'],['808d','TR-808 · LO-FI','1994']];
const KNAME=Object.fromEntries(KITS.map(k=>[k[0],k[1]]));
const LANES=[['drums','DRUMS'],['bass','BASS'],['synth','SYNTH BASS'],['top','TOP'],['vocals','VOCALS'],['other','OTHER'],['kit','KIT']];
const ORIG=[['INTRO',16,1],['BUILD',16,17],['DROP',32,33],['BREAK',16,65],['BUILD',16,81],['DROP',32,97],['OUTRO',16,129]];
const REASONS=['GROWLS','RHYTHM','MIX','ARRANGEMENT','SOUNDS LIKE TRAP','TOO LONG','WHINY','BORING','LOVE IT'];
const RLABEL={vip:'VIP / DROP SWAP',mash:'MASHUP',flip:'GENRE FLIP'};
const STATES=[['empty','Empty'],['bad-file','File can’t be read'],['splitting','Splitting stems'],['reading','Reading the track'],['prebuild','Ready to build'],['building','Building take 1'],['takes','Takes: preparing · rated · starred · A/B'],['swap-pop','Swap sound on a growl clip'],['multisel','Multi-select + shortcuts'],['anatomy','Drop anatomy, zoomed in'],['remixall','REMIX ALL queue mid-run'],['radar','Mash radar results'],['radar-none','Radar: no good matches'],['keys-far','Keys too far apart'],['flip','Genre flip take'],['export-run','Export in progress'],['export-done','Export done'],['err-split','Stem split failed'],['err-engine','Engine offline'],['err-disk','Low disk']];
const R=(seed)=>{let t=seed>>>0;return()=>{t+=0x6D2B79F5;let r=Math.imul(t^t>>>15,1|t);r^=r+Math.imul(r^r>>>7,61|r);return((r^r>>>14)>>>0)/4294967296;};};
const H=(s)=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
const EN=(t,f)=>t==='DROP'?0.92:t==='BUILD'?0.28+0.62*f:t==='BREAK'?0.3:t==='INTRO'?0.22+0.2*f:0.5-0.36*f;
const wc={};
function bars(key,type,lane,nb){const k=key+type+lane+nb;if(wc[k])return wc[k];const r=R(H(k));const n=Math.max(8,Math.min(160,Math.round(nb*2)));const w=100/n;let p='';
 for(let i=0;i<n;i++){const f=i/n;let a=EN(type,f);
  if(lane==='drums'||lane==='kit')a*=i%2===0?1:.45+.2*r();else if(lane==='vocals')a*=Math.floor(i/4)%3===2?.08:.6+.3*r();else if(lane==='bass')a*=.7+.25*r();else a*=.45+.2*Math.sin(i/3)+.15*r();
  const h=Math.max(.5,Math.min(1,a*(.82+.28*r()))*8.5);p+=`M${(i*w+w*.15).toFixed(2)},${(10-h).toFixed(2)}h${(w*.7).toFixed(2)}v${(2*h).toFixed(2)}h-${(w*.7).toFixed(2)}Z`;}
 return wc[k]=p;}
function held(nb,seed){const k='held'+nb+seed;if(wc[k])return wc[k];const r=R(seed);let x=0,p='';const u=100/nb;while(x<nb){const L=Math.min(nb-x,[2,3,4,4,6][Math.floor(r()*5)]);p+=`M${(x*u+.4).toFixed(2)},5h${(L*u-.8).toFixed(2)}v10h-${(L*u-.8).toFixed(2)}Z`;x+=L;}return wc[k]=p;}
function hits(nb,style,seed,pauseAt){const k='hits'+nb+style+seed+pauseAt;if(wc[k])return wc[k];const r=R(seed);const u=100/(nb*16);let p='';
 for(let s=0;s<nb*16;s++){const bar=Math.floor(s/16),st=s%16;if(pauseAt!=null&&bar===pauseAt&&st<8)continue;let on=false,h=7,len=1;
  if(style==='TEAROUT'){on=[0,3,6,10].includes(st)&&!(bar%2&&st===10);h=8.5;len=1;}
  else if(style==='RIDDIM'){on=st%4===0;h=6.5;len=2;}
  else if(style==='TRAP-HYBRID'){on=[0,6,10,11].includes(st);h=7.5;len=1;}
  else {on=st%2===0;h=5+3*Math.abs(Math.sin(s*.4));len=2;}
  if(s===0){on=true;h=9.5;len=4;}
  if(on){const y=(10-h).toFixed(2);p+=`M${(s*u).toFixed(3)},${y}h${(len*u*.8).toFixed(3)}v${(2*h).toFixed(2)}h-${(len*u*.8).toFixed(3)}Z`;}}
 return wc[k]=p;}
function blips(nb,seed){const r=R(seed);const u=100/(nb*4);let p='';for(let b=0;b<nb*4;b++){if(r()<.35){const y=2+r()*6;p+=`M${(b*u).toFixed(2)},${y.toFixed(1)}h${(u*.6).toFixed(2)}v3h-${(u*.6).toFixed(2)}Z`;}}return p;}
function trackBars(){if(wc.tb)return wc.tb;const r=R(7);let p='',at=0;const tot=144;ORIG.forEach(([t,n])=>{for(let i=0;i<n;i++){const a=Math.min(1,EN(t,i/n)*(.7+.3*r()))*9;const x=(at+i)/tot*100;p+=`M${x.toFixed(2)},${(10-a).toFixed(1)}h${(100/tot*.7).toFixed(2)}v${(2*a).toFixed(1)}h-${(100/tot*.7).toFixed(2)}Z`;}at+=n;});return wc.tb=p;}
// groove (DROP 1, 8 bars)
const N=[[0,0,16,0],[1,0,8,0],[1,10,6,12],[2,0,12,0],[2,12,4,5],[3,0,4,0],[3,6,2,0],[3,8,8,10],[4,0,16,0],[5,0,8,0],[5,10,6,12],[6,0,12,0],[6,12,4,7],[7,0,2,0],[7,4,2,0],[7,8,2,0],[7,12,4,12]];
const nx=(n)=>n[0]*40+n[1]*2.5,ny=(p)=>(12-p)*8+1;
const GROOVE={notes:N.map((n,i)=>({x:nx(n).toFixed(1),y:ny(n[3]),w:(n[2]*2.5-1).toFixed(1),f:i===0?'#ff4b2b':'#e9e5da'})),glides:[2,4,7,10,12,16].map(i=>{const a=N[i-1],b=N[i];const x1=nx(a)+a[2]*2.5-1,y1=ny(a[3])+3,x2=nx(b),y2=ny(b[3])+3;return `M${x1.toFixed(1)},${y1} C${(x1+5).toFixed(1)},${y1} ${(x2-5).toFixed(1)},${y2} ${x2.toFixed(1)},${y2}`;}),rows:Array.from({length:13},(_,i)=>({y:i*8,f:[0,3,5,7,10,12].includes(12-i)?'rgba(233,229,218,.05)':'rgba(233,229,218,0)'})),bars:[40,80,120,160,200,240,280]};
let bounce='M0,5';for(let b=0;b<32;b++){const x=b*10;const snare=b%4===2;bounce+=` L${x},5 L${x+.4},${snare?13:16} Q${x+3},7 ${x+9},5`;}
const rg=R(11);let growl='';for(let k=0;k<=64;k++)growl+=(k?'L':'M')+(k*5)+','+(10+Math.sin(k/3.1)*5*(.5+rg()*.5)).toFixed(1);
const WOB=['1/8','1/8T','1/16','1/4T','1/8','1/8T','1/16T','1/16'].map((d,i)=>({num:d.replace('T',''),t:d.endsWith('T')?'TRIP':'',title:d+' · '+['sine','sine','square','saw','sine','square','saw','square'][i]}));
const DRUMS={bars:['25','26','27','28','29','30','31','32','33','34','35','36','37','38','39','40'],K:[4,4,4,4,4,4,2,0,3,3,3,3,3,3,3,3],S:[2,2,2,2,4,8,16,0,1,1,1,1,1,1,1,2],H:[8,8,8,8,8,8,0,0,6,6,6,6,6,6,6,6]};
function fmtT(s){const m=Math.floor(s/60),r=s-m*60;return m+':'+(r<10?'0':'')+r.toFixed(1);}
function fmtLen(bars,bpm){const s=Math.round(bars*240/bpm);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function stLabel(st){return st>0?'+'+st+' st':st<0?'−'+(-st)+' st':'same key';}
// Build the arrangement of a take from recipe + seed. Designed options only; weights come from rating counts.
function arrange(recipe,seed,nextId,opt){const r=R(seed);const out=ORIG.map(([type,b,at])=>({id:nextId(),type,bars:b,src:'A',at}));
 if(recipe==='mash'){let k=0;out.forEach(x=>{if(x.type==='DROP'){x.src='B';x.at=k++?97:49;}});}
 out.forEach(x=>{if(x.type==='DROP'){x.pause=r()<.5?7:11;x.sw=(recipe==='flip'&&opt.flip==='traphy')?2:(r()<.5?4:8);}});
 if(opt.vipDouble&&recipe==='vip'){const i=out.map(x=>x.type).lastIndexOf('DROP');out.splice(i+1,0,{...out[i],id:nextId(),vip:true});}
 return out;}
function pickStyle(recipe,seed,taste,opt){if(recipe==='flip')return FLIPS.find(f=>f.id===opt.flip).name;if(recipe==='mash')return 'MASHUP';
 const opts=['TEAROUT','RIDDIM','TRAP-HYBRID'];const w=opts.map(o=>Math.max(.2,1+(taste[o]||0)*.6));const tot=w.reduce((a,b)=>a+b,0);let x=R(seed^99)()*tot;for(let i=0;i<3;i++){x-=w[i];if(x<=0)return opts[i];}return opts[0];}
function defaultPatch(style){return style==='TEAROUT'?'chomp':style==='RIDDIM'?'wub':style==='TRAP-HYBRID'?'line808':'wubc';}
window.RemixEngine={INK,DIM,EMB,AMB,ICE,OKC,BG,ROSE,SC,T,LIB,MATCH,RADAR,PTABS,PATCH,TOPS,PNAME,PFAM,FLIPS,KITS,KNAME,LANES,ORIG,REASONS,RLABEL,STATES,R,H,EN,bars,held,hits,blips,trackBars,GROOVE,bounce,growl,WOB,DRUMS,fmtT,fmtLen,stLabel,arrange,pickStyle,defaultPatch};
})();
