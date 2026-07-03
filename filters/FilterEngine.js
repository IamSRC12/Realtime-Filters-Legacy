/**
 * FilterEngine.js — High-quality WebGL multi-pass filter engine
 *
 * UV strategy (fixes mirror artifact in multi-pass):
 *  - UNPACK_FLIP_Y_WEBGL = true  → videoTex stored Y=0-at-bottom (GL convention)
 *  - Vertex shader: standard UV (no flip)  → all passes consistent
 *  - Mirror pass first: horizontal-flip camera into sourceFBO
 *    so every subsequent pass sources from sourceFBO.tex with no UV tricks
 *
 * ponytail: crossfade removed — it was the _renderTarget source of corruption.
 *           instant switch is imperceptible at 30+fps.
 */

/* ── Vertex shader: standard, no flips ─────────────────── */
const VERT = `
attribute vec2 a_pos;
varying   vec2 v_uv;
void main(){
  v_uv        = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/* ── Preamble injected into every fragment shader ────────── */
const P = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
#else
  precision mediump float;
#endif
varying vec2      v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_orig;
uniform sampler2D u_edge;
uniform float     u_t;
uniform vec2      u_px;
uniform float     u_time;

float lum(vec3 c){ return dot(c,vec3(0.299,0.587,0.114)); }

vec3 rgb2hsv(vec3 c){
  vec4 K=vec4(0.,-1./3.,2./3.,-1.);
  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
  float d=q.x-min(q.w,q.y),e=1e-10;
  return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K=vec4(1.,2./3.,1./3.,3.);
  return c.z*mix(K.xxx,clamp(abs(fract(c.xxx+K.xyz)*6.-K.www)-K.xxx,0.,1.),c.y);
}
`;

/* ── Mirror/flip pass (horizontal) ── */
const FS_FLIP = P + `
void main(){
  gl_FragColor = vec4(texture2D(u_tex, vec2(1.0-v_uv.x, v_uv.y)).rgb, 1.);
}`;

/* ── Pass-through blit ── */
const FS_PASS = P + `
void main(){ gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.); }`;

/* ──────────────────────────────────────────────────────────
   SEPARABLE BILATERAL BLUR — edge-preserving smooth
   Two separate passes (H + V) for quality + performance
   sigS controls spatial spread, sigC controls colour threshold
────────────────────────────────────────────────────────── */
const FS_BIL_H = P + `
void main(){
  vec3 ctr=texture2D(u_tex,v_uv).rgb;
  float sigS=2.0+u_t*5.0, sigC=0.10;
  vec3 sum=vec3(0.); float wsum=0.;
  for(int i=-6;i<=6;i++){
    float x=float(i);
    vec3 nb=texture2D(u_tex, v_uv+vec2(x*u_px.x*sigS,0.)).rgb;
    float sw=exp(-x*x/(2.*sigS*sigS));
    vec3 dc=ctr-nb;
    float rw=exp(-dot(dc,dc)/(2.*sigC*sigC));
    float w=sw*rw; sum+=nb*w; wsum+=w;
  }
  gl_FragColor=vec4(sum/wsum,1.);
}`;

const FS_BIL_V = P + `
void main(){
  vec3 ctr=texture2D(u_tex,v_uv).rgb;
  float sigS=2.0+u_t*5.0, sigC=0.10;
  vec3 sum=vec3(0.); float wsum=0.;
  for(int i=-6;i<=6;i++){
    float y=float(i);
    vec3 nb=texture2D(u_tex, v_uv+vec2(0.,y*u_px.y*sigS)).rgb;
    float sw=exp(-y*y/(2.*sigS*sigS));
    vec3 dc=ctr-nb;
    float rw=exp(-dot(dc,dc)/(2.*sigC*sigC));
    float w=sw*rw; sum+=nb*w; wsum+=w;
  }
  gl_FragColor=vec4(sum/wsum,1.);
}`;

/* ── Separable Gaussian blur (for glow / DOF effects) ── */
const FS_GAUSS_H = P + `
void main(){
  float sig=1.5+u_t*4.0;
  vec3 s=vec3(0.); float w=0.;
  for(int i=-5;i<=5;i++){
    float x=float(i);
    float wt=exp(-x*x/(2.*sig*sig));
    s+=texture2D(u_tex,v_uv+vec2(x*u_px.x*sig,0.)).rgb*wt;
    w+=wt;
  }
  gl_FragColor=vec4(s/w,1.);
}`;
const FS_GAUSS_V = P + `
void main(){
  float sig=1.5+u_t*4.0;
  vec3 s=vec3(0.); float w=0.;
  for(int i=-5;i<=5;i++){
    float y=float(i);
    float wt=exp(-y*y/(2.*sig*sig));
    s+=texture2D(u_tex,v_uv+vec2(0.,y*u_px.y*sig)).rgb*wt;
    w+=wt;
  }
  gl_FragColor=vec4(s/w,1.);
}`;

/* ── Sobel edge detection → stores magnitude in .r ── */
const FS_SOBEL = P + `
void main(){
  vec2 p=u_px;
  float tl=lum(texture2D(u_tex,v_uv+vec2(-p.x,-p.y)).rgb);
  float tm=lum(texture2D(u_tex,v_uv+vec2(0.,-p.y)).rgb);
  float tr=lum(texture2D(u_tex,v_uv+vec2(p.x,-p.y)).rgb);
  float ml=lum(texture2D(u_tex,v_uv+vec2(-p.x,0.)).rgb);
  float mr=lum(texture2D(u_tex,v_uv+vec2(p.x,0.)).rgb);
  float bl=lum(texture2D(u_tex,v_uv+vec2(-p.x,p.y)).rgb);
  float bm=lum(texture2D(u_tex,v_uv+vec2(0.,p.y)).rgb);
  float br=lum(texture2D(u_tex,v_uv+vec2(p.x,p.y)).rgb);
  float gx=-tl-2.*ml-bl+tr+2.*mr+br;
  float gy=-tl-2.*tm-tr+bl+2.*bm+br;
  float e=sqrt(gx*gx+gy*gy);
  gl_FragColor=vec4(e,e,e,1.);
}`;

/* ══════════════════════════════════════════════════════
   COMPOSITE FILTER SHADERS
   u_tex  = processed (blurred/glow etc.)
   u_orig = camera source (mirrorFBO)
   u_edge = Sobel edge map
══════════════════════════════════════════════════════ */

/* ── NORMAL ── */
const FS_NORMAL = P + `
void main(){ gl_FragColor=vec4(texture2D(u_orig,v_uv).rgb,1.); }`;

/* ── ANIME — true 2D cel-art look
   Pipeline: 4× bilateral smooth → 4-band hard cel → shadow tint → specular → ink

   Key visual signatures of anime:
   • Very flat colour regions (no texture)
   • Hard DISTINCT brightness bands (4 max)
   • Shadows are COOL (blue-purple) not just darker
   • Highlights blow to warm white
   • Sharp thin ink outlines
── */
const FS_ANIME = P + `
void main(){
  vec3  s    = texture2D(u_tex,  v_uv).rgb;   /* 4× bilateral smooth       */
  float edge = texture2D(u_edge, v_uv).r;      /* Sobel on original frame   */
  vec3  hsv  = rgb2hsv(s);
  float origV = hsv.z;
  float origS = hsv.y;
  float origH = hsv.x;

  /* ── CONTRAST LIFT — push pixels toward extremes for visible bands ── */
  /* Anime has high contrast: darks are dark, lights are light */
  float v = clamp((origV - 0.45) * 1.55 + 0.45, 0.0, 1.0);

  /* ── 4-BAND HARD CEL SHADING ── */
  /* AA = 0.014: tight transition = graphical flat look */
  float aa  = 0.014;
  float cel = 0.06;                                                  /* deep shadow  */
  cel = mix(cel, 0.33, smoothstep(0.22-aa, 0.22+aa, v));            /* shadow       */
  cel = mix(cel, 0.62, smoothstep(0.46-aa, 0.46+aa, v));            /* base/mid     */
  cel = mix(cel, 0.92, smoothstep(0.76-aa, 0.76+aa, v));            /* highlight    */

  /* ── SHADOW MASK for colour adjustments ── */
  float inShadow   = 1.0 - smoothstep(0.0,  0.38, cel);             /* dark regions */
  float inHighlight= smoothstep(0.75, 0.92, cel);                   /* light regions*/
  float inMid      = 1.0 - inShadow - inHighlight;
  inMid            = clamp(inMid, 0., 1.);

  /* ── HUE: shift shadows toward blue-indigo (anime cool shadow) ── */
  float hShift = -0.07 * inShadow * u_t           /* cool in shadow  */
               + 0.01  * inHighlight * u_t;        /* slight warm up in light */
  hsv.x = fract(origH + hShift);

  /* ── SATURATION: vivid mid, muted extremes ── */
  float sMid  = 1.6 + 0.5 * u_t;          /* mids: high saturation */
  float sSha  = 0.7;                        /* shadows: desaturated  */
  float sHi   = 0.5 + 0.3 * u_t;          /* highlights: pale       */
  float satMul= sSha * inShadow + sMid * inMid + sHi * inHighlight;
  hsv.y = clamp(origS * satMul, 0., 1.);

  /* Apply cel brightness */
  hsv.z = cel;
  vec3 col = hsv2rgb(hsv);

  /* ── BLUE-PURPLE SHADOW TINT ── */
  /* Anime shadow colour = local colour desaturated + cool bias */
  vec3 shadowCol = mix(col, vec3(0.08, 0.10, 0.22), 0.55);
  col = mix(col, shadowCol, inShadow * u_t * 0.75);

  /* ── SPECULAR BLOWOUT: top 8% brightness → warm white ── */
  /* Use ORIGINAL v (before contrast lift) to detect genuine specular */
  float specMask = smoothstep(0.82, 0.96, origV);
  col = mix(col, vec3(1.0, 0.975, 0.93), specMask * u_t * 0.88);

  /* ── SHARP INK OUTLINES ── */
  float thresh = 0.13 - u_t * 0.035;
  float ink    = 1.0 - smoothstep(thresh, thresh + 0.016, edge);
  /* Ink colour: near-black with slight warm brown (not pure black) */
  col = mix(col * vec3(0.04, 0.03, 0.05), col, ink);

  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

/* ── CARTOON — Pixar/DreamWorks 3D look
   Warm LUT, smooth 3-band toon shading (not flat like anime),
   subsurface scattering, rim light, soft outlines ── */
const FS_CARTOON = P + `
void main(){
  vec3 s    = texture2D(u_tex,  v_uv).rgb;   /* bilateral smooth */
  float edge= texture2D(u_edge, v_uv).r;
  float v   = lum(s);

  /* ── Warm cinematic colour grade (Pixar = warm shadows) ── */
  vec3 warm;
  warm.r = s.r * 1.08 + 0.02;              /* red lifted   */
  warm.g = s.g * 1.00;                      /* green neutral */
  warm.b = s.b * 0.82 - 0.01;              /* blue pulled   */
  warm = clamp(warm, 0., 1.);

  /* ── 3-band smooth toon shading (softer than anime — more 3D) ── */
  float aa  = 0.06;                         /* wider AA = smoother 3D feel */
  float cel = 0.20;                         /* shadow */
  cel = mix(cel, 0.62, smoothstep(0.35-aa, 0.35+aa, v));  /* mid    */
  cel = mix(cel, 1.00, smoothstep(0.68-aa, 0.68+aa, v));  /* bright */

  /* Blend toon with original — 3D cartoon is NOT fully flat */
  float toonMix = 0.55 + u_t * 0.3;
  vec3 hsv = rgb2hsv(warm);
  hsv.z = mix(hsv.z, cel, toonMix);
  hsv.y = min(1.0, hsv.y * (1.35 + u_t * 0.15));  /* vivid but not anime-vivid */
  warm = hsv2rgb(hsv);

  /* ── Subsurface scattering: warm red glow at shadow-to-light edge ── */
  float sss = smoothstep(0.28, 0.46, v) * (1.0 - smoothstep(0.46, 0.62, v));
  warm = mix(warm, warm * vec3(1.25, 0.88, 0.82), sss * u_t * 0.5);

  /* ── Rim lighting: bright warm edge on lit side ── */
  float rim = clamp(edge * 4.0, 0., 1.) * smoothstep(0.55, 0.85, v);
  warm += vec3(0.30, 0.22, 0.10) * rim * u_t * 0.45;

  /* ── Soft 3D-like outlines (thicker, softer than anime) ── */
  float thresh = mix(0.22, 0.12, u_t);
  warm *= 1.0 - smoothstep(thresh, thresh + 0.07, edge) * 0.92;

  gl_FragColor = vec4(clamp(warm, 0., 1.), 1.);
}`;

/* ── SKETCH ── */
const FS_SKETCH = P + `
void main(){
  float orig    = lum(texture2D(u_orig, v_uv).rgb);
  float blurred = lum(texture2D(u_tex,  v_uv).rgb);
  float dodge   = clamp(orig / max(1.-blurred, 0.005), 0., 1.);
  float sketch  = 1.-dodge;
  sketch = mix(orig, sketch, u_t);
  sketch = clamp((sketch-0.5)*1.3+0.5, 0., 1.);
  vec3 paper  = vec3(0.96, 0.94, 0.88);
  vec3 pencil = vec3(0.10, 0.08, 0.06);
  gl_FragColor = vec4(mix(paper, pencil, 1.-sketch), 1.);
}`;

/* ── WATERCOLOR ── */
const FS_WATERCOLOR = P + `
void main(){
  vec3 smooth = texture2D(u_tex,  v_uv).rgb;
  vec3 orig   = texture2D(u_orig, v_uv).rgb;
  vec3 hsv = rgb2hsv(smooth);
  hsv.y = min(1., hsv.y*(1.4+u_t*0.4));
  hsv.x = fract(hsv.x+0.005*u_t);
  smooth = hsv2rgb(hsv);
  float hi = smoothstep(0.78, 1.0, lum(smooth));
  smooth = mix(smooth, vec3(0.97,0.95,0.90), hi*0.4*u_t);
  float edgeHint = abs(lum(orig)-lum(smooth));
  smooth = mix(smooth, orig*0.55, edgeHint*0.18*u_t);
  gl_FragColor = vec4(clamp(smooth,0.,1.),1.);
}`;

/* ── NEON ── */
const FS_NEON = P + `
void main(){
  float glow  = lum(texture2D(u_tex,  v_uv).rgb);
  float sharp = texture2D(u_edge, v_uv).r;
  vec3  orig  = texture2D(u_orig, v_uv).rgb;
  vec3  dark  = orig * (1.-u_t*0.88);
  /* Hue cycles continuously across screen position */
  float hue   = fract(v_uv.x*0.45+v_uv.y*0.3+u_time*0.04);
  vec3  neon  = hsv2rgb(vec3(hue,1.,1.));
  vec3  result= dark
    + neon * sharp * u_t * 2.5
    + neon * glow  * u_t * 0.8;
  /* Reinhard tone map */
  result = result/(1.+result);
  gl_FragColor = vec4(clamp(result,0.,1.),1.);
}`;

/* ── OIL PAINTING ── */
const FS_OIL = P + `
void main(){
  float radius=1.5+u_t*4., levels=8.;
  vec3 ctr=texture2D(u_orig,v_uv).rgb;
  float cb=floor(lum(ctr)*levels);
  vec3 mSum=vec3(0.); float mCnt=0.; vec3 aSum=vec3(0.);
  for(int x=-4;x<=4;x++){
    for(int y=-4;y<=4;y++){
      float fx=float(x),fy=float(y);
      vec3 nb=texture2D(u_orig,v_uv+vec2(fx,fy)*u_px*radius/4.).rgb;
      float nb_b=floor(lum(nb)*levels);
      float hit=1.-step(0.5,abs(nb_b-cb));
      mSum+=nb*hit; mCnt+=hit; aSum+=nb;
    }
  }
  vec3 col=mCnt>0.5?mSum/mCnt:aSum/81.;
  vec3 hsv=rgb2hsv(col); hsv.y=min(1.,hsv.y*(1.2+u_t*0.4));
  gl_FragColor=vec4(clamp(hsv2rgb(hsv),0.,1.),1.);
}`;

/* ── VINTAGE ── */
const FS_VINTAGE = P + `
float rand(vec2 co){ return fract(sin(dot(co,vec2(12.9898,78.233)))*43758.5453); }
void main(){
  vec3 c=texture2D(u_orig,v_uv).rgb;
  vec3 sep=vec3(dot(c,vec3(0.393,0.769,0.189)),dot(c,vec3(0.349,0.686,0.168)),dot(c,vec3(0.272,0.534,0.131)));
  c=mix(c,clamp(sep,0.,1.),u_t);
  c+=vec3(0.03,0.015,0.0)*u_t;
  vec2 uv2=v_uv*2.-1.;
  c*=1.-dot(uv2,uv2)*0.65*u_t;
  float rBleed=texture2D(u_orig,v_uv+vec2(u_px.x*2.,0.)).r;
  c.r=mix(c.r,rBleed*0.8,0.15*u_t);
  c=clamp(c+(rand(v_uv+fract(u_time*0.31))-0.5)*0.1*u_t,0.,1.);
  gl_FragColor=vec4(c,1.);
}`;

/* ── PIXELATE ── */
const FS_PIXELATE = P + `
void main(){
  float bs=floor(4.+u_t*24.);
  vec2 res=1./u_px;
  vec2 uv=floor(v_uv*res/bs)*bs/res;
  gl_FragColor=vec4(texture2D(u_orig,uv).rgb,1.);
}`;

/* ── EMBOSS ── */
const FS_EMBOSS = P + `
void main(){
  vec2 p=u_px;
  float tl=lum(texture2D(u_orig,v_uv+vec2(-p.x,-p.y)).rgb);
  float ml=lum(texture2D(u_orig,v_uv+vec2(-p.x,0.)).rgb);
  float tm=lum(texture2D(u_orig,v_uv+vec2(0.,-p.y)).rgb);
  float mm=lum(texture2D(u_orig,v_uv).rgb);
  float mr=lum(texture2D(u_orig,v_uv+vec2(p.x,0.)).rgb);
  float bm=lum(texture2D(u_orig,v_uv+vec2(0.,p.y)).rgb);
  float br=lum(texture2D(u_orig,v_uv+vec2(p.x,p.y)).rgb);
  float e=(-2.*tl-ml-tm+mm+mr+bm+2.*br)*0.5+0.5;
  vec3 stone=vec3(e*0.95,e*0.90,e*0.80);
  gl_FragColor=vec4(mix(texture2D(u_orig,v_uv).rgb,stone,u_t),1.);
}`;

/* ── THERMAL ── */
const FS_THERMAL = P + `
void main(){
  vec3 c=texture2D(u_orig,v_uv).rgb;
  float l=lum(c);
  vec3 bb;
  bb.r=clamp(3.*l,0.,1.);
  bb.g=clamp(3.*l-1.,0.,1.);
  bb.b=clamp(3.*l-2.,0.,1.);
  float mid=smoothstep(0.3,0.5,l)-smoothstep(0.5,0.7,l);
  bb.g=max(bb.g,mid); bb.b=max(bb.b,mid*0.3);
  gl_FragColor=vec4(mix(c,bb,u_t),1.);
}`;

/* ── GLITCH ── */
const FS_GLITCH = P + `
float hash(float n){ return fract(sin(n)*43758.5453); }
void main(){
  vec2 uv=v_uv;
  float row=floor(v_uv.y*60.);
  float t=floor(u_time*12.);
  if(hash(row+t)>1.-u_t*0.55){
    float shift=(hash(row*3.+t+1.)-0.5)*u_t*0.14;
    uv.x=fract(uv.x+shift);
  }
  vec2 block=floor(v_uv*vec2(20.,14.));
  float bNoise=hash(block.x+block.y*31.+t);
  if(bNoise>1.-u_t*0.12) uv=fract(uv+vec2(hash(block.x+t)*0.05,0.));
  float cs=u_t*0.018;
  float r=texture2D(u_orig,vec2(uv.x+cs,uv.y)).r;
  float g=texture2D(u_orig,uv).g;
  float b=texture2D(u_orig,vec2(uv.x-cs,uv.y)).b;
  float scan=1.-step(0.5,fract(v_uv.y*(200.+u_t*200.)))*0.08*u_t;
  gl_FragColor=vec4(vec3(r,g,b)*scan,1.);
}`;

/* ── INFRARED ── */
const FS_INFRARED = P + `
void main(){
  vec3 c=texture2D(u_orig,v_uv).rgb;
  float l=lum(c);
  vec3 ir=vec3(c.b*0.7+l*0.3,c.g*1.2+l*0.2,c.r*0.3);
  float heat=dot(c,vec3(0.07,0.72,0.21));
  vec3 fc;
  fc.r=clamp(2.*heat,0.,1.);
  fc.g=clamp(2.*heat-0.5,0.,1.);
  fc.b=clamp(3.*(1.-heat)-1.,0.,1.);
  fc=mix(fc,ir,0.4);
  gl_FragColor=vec4(mix(c,fc,u_t),1.);
}`;

/* ── DREAMY BLOOM ── */
const FS_DREAMY = P + `
void main(){
  vec3 sharp=texture2D(u_orig,v_uv).rgb;
  vec3 bloom=texture2D(u_tex, v_uv).rgb;
  float brightness=max(0.,lum(bloom)-0.3);
  vec3 glowCol=bloom*brightness*2.;
  vec3 result=sharp+glowCol*u_t*1.2;
  vec3 hsv=rgb2hsv(result); hsv.y=min(1.,hsv.y*1.1); result=hsv2rgb(hsv);
  result*=vec3(1.04,1.01,0.97);
  gl_FragColor=vec4(clamp(result/(1.+result),0.,1.),1.);
}`;

/* ── CYBERPUNK — full dramatic transformation
   Crush shadows, teal/orange remap, neon edge glow,
   chromatic aberration, scanlines, vignette ── */
const FS_CYBER = P + `
float hash2(float n){ return fract(sin(n)*43758.5453); }
void main(){
  vec3  orig = texture2D(u_orig, v_uv).rgb;
  float edge = texture2D(u_edge, v_uv).r;
  float l    = lum(orig);

  /* ── Step 1: Crush shadows — cyberpunk is DARK ── */
  vec3 dark = pow(orig, vec3(1.4)) * 0.65;

  /* ── Step 2: Teal-orange colour remap (cinematic LUT) ── */
  /* Shadows → deep teal, Highlights → warm amber */
  vec3 shadowCol = vec3(0.02, 0.18, 0.28) + orig * vec3(0.0,  0.55, 0.80);
  vec3 hiCol     = vec3(0.20, 0.12, 0.00) + orig * vec3(1.0,  0.65, 0.10);
  vec3 remap = mix(shadowCol, hiCol, smoothstep(0.20, 0.80, l));
  vec3 result = mix(dark, remap, u_t * 0.85);

  /* ── Step 3: Neon edge glow (cyan + magenta cycling) ── */
  float nHue   = fract(v_uv.x*0.4 + v_uv.y*0.25 + u_time*0.035);
  vec3  neon   = hsv2rgb(vec3(nHue, 1., 1.));
  float glow   = smoothstep(0.12, 0.40, edge);      /* broader glow zone */
  float sharp  = smoothstep(0.30, 0.60, edge);      /* core bright line  */
  result += neon * glow  * u_t * 0.90;
  result += neon * sharp * u_t * 1.40;

  /* ── Step 4: Neon grid (subtle perspective lines) ── */
  vec2 grid = fract(v_uv * vec2(45., 32.));
  float gridLine = step(0.96, max(grid.x, grid.y));
  result += vec3(0.0, 0.65, 0.90) * gridLine * 0.18 * u_t;

  /* ── Step 5: Chromatic aberration (R/B channel offset) ── */
  float ca = u_t * 0.009;
  result.r += texture2D(u_orig, v_uv + vec2(ca,  0.)).r * 0.5 * u_t;
  result.b += texture2D(u_orig, v_uv - vec2(ca,  0.)).b * 0.5 * u_t;

  /* ── Step 6: Scanlines ── */
  float scan = 1.0 - sin(v_uv.y * 380.0) * 0.06 * u_t;
  result *= scan;

  /* ── Step 7: Vignette ── */
  vec2 vc = v_uv * 2.0 - 1.0;
  result *= 1.0 - dot(vc, vc) * 0.45 * u_t;

  /* ── Tone map: punchier than Reinhard ── */
  result = result / (0.45 + result);

  gl_FragColor = vec4(clamp(result, 0., 1.), 1.);
}`;

/* ══════════════════════════════════════════════════════
   FilterEngine CLASS
══════════════════════════════════════════════════════ */
class FilterEngine {
  constructor(canvas) {
    this.canvas        = canvas;
    this.currentFilter = 'normal';
    this.intensity     = 0.75;
    this.time          = 0;

    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: false })
            || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL not supported.');
    this.gl = gl;
    this._setup();
  }

  /* ── compile & cache ── */
  _setup() {
    const gl = this.gl;
    const w  = this.canvas.width, h = this.canvas.height;

    /* Full-screen quad */
    const q = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, q);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1,1,-1,-1,1,1,-1,1,1,-1,1]), gl.STATIC_DRAW);
    this._quad = q;

    /* Raw video texture */
    this._videoTex = this._makeTex();

    /* FBOs: [0],[1] for bilateral ping-pong; [2] for Sobel/glow; [3] camera mirror */
    this._fbo = Array.from({length:4}, () => this._makeFBO(w, h));

    /* Compile all programs */
    const vs = this._sh(gl.VERTEX_SHADER, VERT);
    const all = {
      flip:      FS_FLIP,    pass:     FS_PASS,
      bilH:      FS_BIL_H,  bilV:     FS_BIL_V,
      gaussH:    FS_GAUSS_H,gaussV:   FS_GAUSS_V,
      sobel:     FS_SOBEL,
      normal:    FS_NORMAL,
      anime:     FS_ANIME,   cartoon:  FS_CARTOON,
      sketch:    FS_SKETCH,  watercolor: FS_WATERCOLOR,
      neon:      FS_NEON,    oilpainting: FS_OIL,
      vintage:   FS_VINTAGE, pixelate: FS_PIXELATE,
      emboss:    FS_EMBOSS,  thermal:  FS_THERMAL,
      glitch:    FS_GLITCH,  infrared: FS_INFRARED,
      dreamy:    FS_DREAMY,  cyberpunk: FS_CYBER,
    };
    this._P = {};
    const UNIFORMS = ['u_tex','u_orig','u_edge','u_t','u_px','u_time'];
    for (const [name, fsSrc] of Object.entries(all)) {
      const fs = this._sh(gl.FRAGMENT_SHADER, fsSrc);
      const p  = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error(`[${name}]`, gl.getProgramInfoLog(p)); continue;
      }
      const locs = { a_pos: gl.getAttribLocation(p, 'a_pos') };
      for (const u of UNIFORMS) locs[u] = gl.getUniformLocation(p, u);
      this._P[name] = { p, locs };
    }
    gl.deleteShader(vs);
  }

  _sh(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error('[GLSL]', gl.getShaderInfoLog(s));
    return s;
  }

  _makeTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _makeFBO(w, h) {
    const gl = this.gl, tex = this._makeTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  /* ── draw quad: tex/orig/edge → target FBO (null = screen) ── */
  _draw(progName, tex, orig, edge, target) {
    const gl  = this.gl;
    const prg = this._P[progName];
    if (!prg) return;
    const L   = prg.locs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(prg.p);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    if (L.a_pos >= 0) {
      gl.enableVertexAttribArray(L.a_pos);
      gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
    }

    let unit = 0;
    const bind = (uname, t) => {
      if (!t || L[uname] == null) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(L[uname], unit++);
    };
    bind('u_tex',  tex);
    bind('u_orig', orig);
    bind('u_edge', edge);

    if (L.u_t    != null) gl.uniform1f(L.u_t,    this.intensity);
    if (L.u_time != null) gl.uniform1f(L.u_time,  this.time);
    if (L.u_px   != null) gl.uniform2f(L.u_px,    1/this.canvas.width, 1/this.canvas.height);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ── Bilateral smooth: 2 passes → returns smoothed texture ── */
  _bilateral(src) {
    this._draw('bilH', src,              null, null, this._fbo[0]);
    this._draw('bilV', this._fbo[0].tex, null, null, this._fbo[1]);
    return this._fbo[1].tex;
  }

  /* ── Gaussian blur: 2 passes → returns blurred texture ── */
  _gaussian(src) {
    this._draw('gaussH', src,              null, null, this._fbo[0]);
    this._draw('gaussV', this._fbo[0].tex, null, null, this._fbo[1]);
    return this._fbo[1].tex;
  }

  /* ── Sobel edge map ── */
  _sobel(src) {
    this._draw('sobel', src, null, null, this._fbo[2]);
    return this._fbo[2].tex;
  }

  /* ═══════════════════════════════════════════
     RENDER — single entry point
  ═══════════════════════════════════════════ */
  render(video, dt = 0.016) {
    this.time += dt;

    /* Upload video frame (UNPACK_FLIP_Y=true fixes Y orientation) */
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this._videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    /* Camera mirror pass: horizontal flip into fbo[3]
       ALL subsequent passes source from fbo[3].tex                */
    this._draw('flip', this._videoTex, null, null, this._fbo[3]);
    const src = this._fbo[3].tex;   /* mirrored source — used everywhere below */

    /* Dispatch filter */
    const f = this.currentFilter;
    switch (f) {
      case 'normal':
        this._draw('normal', null, src, null, null);
        break;

      case 'anime': {
        /* 4× bilateral passes for anime: produces the flat cel-shading
           regions that make anime look like anime.
           ponytail: yes this is 4 extra GPU passes vs cartoon's 2.
           Ceiling: ~25fps on very low-end integrated GPU (720p). */
        this._draw('bilH', src,              null, null, this._fbo[0]);
        this._draw('bilV', this._fbo[0].tex, null, null, this._fbo[1]);
        this._draw('bilH', this._fbo[1].tex, null, null, this._fbo[0]);
        this._draw('bilV', this._fbo[0].tex, null, null, this._fbo[1]);
        const smooth = this._fbo[1].tex;
        /* Sobel on ORIGINAL source — preserves real edge positions */
        const edges  = this._sobel(src);
        this._draw('anime', smooth, smooth, edges, null);
        break;
      }
      case 'cartoon': {
        const smooth = this._bilateral(src);
        const edges  = this._sobel(src);
        this._draw('cartoon', smooth, smooth, edges, null);
        break;
      }
      case 'sketch': {
        const blurred = this._gaussian(src);
        this._draw('sketch', blurred, src, null, null);
        break;
      }
      case 'watercolor': {
        const smooth = this._bilateral(src);
        this._draw('watercolor', smooth, src, null, null);
        break;
      }
      case 'neon': {
        const blurred = this._gaussian(src);
        const edges   = this._sobel(src);
        this._draw('neon', blurred, src, edges, null);
        break;
      }
      case 'dreamy': {
        const blurred = this._gaussian(src);
        this._draw('dreamy', blurred, src, null, null);
        break;
      }
      case 'cyberpunk': {
        const edges = this._sobel(src);
        this._draw('cyberpunk', null, src, edges, null);
        break;
      }
      /* Single-pass filters that only need src */
      default:
        this._draw(f, src, src, null, null);
        break;
    }
  }

  /* ponytail: instant switch, no crossfade (crossfade was the _renderTarget bug source) */
  switchFilter(name) { this.currentFilter = name; }
}
