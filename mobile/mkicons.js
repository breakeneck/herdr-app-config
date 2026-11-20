// Generates icon PNGs (no deps). Run: node mkicons.js
const zlib = require('zlib'), fs = require('fs');
function crc(b){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}let r=0xffffffff;for(const x of b)r=t[(r^x)&255]^(r>>>8);return(r^0xffffffff)>>>0}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])}
function seg(px,py,ax,ay,bx,by,w){const dx=bx-ax,dy=by-ay;let t=((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy);t=Math.max(0,Math.min(1,t));return Math.hypot(px-ax-t*dx,py-ay-t*dy)<=w}
function make(n){const raw=Buffer.alloc((n*4+1)*n);const s=n/512;for(let y=0;y<n;y++){raw[y*(n*4+1)]=0;for(let x=0;x<n;x++){const px=x/s,py=y/s;let c=[0x1c,0x1f,0x26];
 if(seg(px,py,150,170,260,256,22)||seg(px,py,260,256,150,342,22)||(px>290&&px<388&&py>316&&py<356))c=[0x4c,0x8d,0xff];
 const o=y*(n*4+1)+1+x*4;raw[o]=c[0];raw[o+1]=c[1];raw[o+2]=c[2];raw[o+3]=255}}
 const ih=Buffer.alloc(13);ih.writeUInt32BE(n,0);ih.writeUInt32BE(n,4);ih[8]=8;ih[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
for(const n of [192,512])fs.writeFileSync(__dirname+'/public/icon-'+n+'.png',make(n));
