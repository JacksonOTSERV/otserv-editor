// Renderizador WebGL2 da CAMADA BASE do mapa (ground + itens) com atlas de textura + instancing.
// Offscreen: desenha tudo numa pass na GPU; o renderer 2D compõe via drawImage e mantém overlays/grid/seleção.
// API: const gl = new MapGL(); gl.begin(w,h); gl.draw(canvas32, key, dx,dy,dw,dh, alpha); gl.end(); ctx.drawImage(gl.canvas,0,0)
'use strict';

const ATLAS = 4096;       // textura do atlas (px)
const VS = `#version 300 es
layout(location=0) in vec2 aQuad;       // unit quad 0..1
layout(location=1) in vec4 aRect;       // x,y,w,h (px)
layout(location=2) in vec4 aUV;         // u0,v0,u1,v1
layout(location=3) in float aAlpha;
uniform vec2 uRes;
out vec2 vUV; out float vA;
void main(){
  vec2 p = aRect.xy + aQuad * aRect.zw;          // px
  vec2 clip = vec2(p.x/uRes.x*2.0-1.0, 1.0-p.y/uRes.y*2.0); // y-flip
  gl_Position = vec4(clip,0.0,1.0);
  vUV = mix(aUV.xy, aUV.zw, aQuad);
  vA = aAlpha;
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in float vA; uniform sampler2D uTex; out vec4 o;
void main(){ vec4 c = texture(uTex, vUV); o = vec4(c.rgb, c.a*vA); }`;

class MapGL {
  constructor() {
    this.ok = false;
    try {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false });
      if (!gl) return;
      this.gl = gl;
      this.prog = this._prog(VS, FS);
      this.uRes = gl.getUniformLocation(this.prog, 'uRes');
      this.uTex = gl.getUniformLocation(this.prog, 'uTex');
      // unit quad
      this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      // instance buffer (dynamic)
      this.ibuf = gl.createBuffer();
      // atlas texture
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.atlas = new Map();  // key -> {u0,v0,u1,v1}
      this.px = 0; this.py = 0; this.rowH = 0; // shelf packer
      this.inst = new Float32Array(9 * 4096); // x,y,w,h,u0,v0,u1,v1,a por instância
      this.n = 0;
      this.ok = true;
    } catch (e) { this.ok = false; }
  }
  _prog(vs, fs) { const gl = this.gl; const c = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; }; const p = gl.createProgram(); gl.attachShader(p, c(gl.VERTEX_SHADER, vs)); gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
  // garante o sprite no atlas (src = canvas WxH). retorna uv ou null se não couber.
  _ensure(key, src) {
    let uv = this.atlas.get(key); if (uv) return uv;
    const gl = this.gl, w = src.width, h = src.height;
    if (w > ATLAS || h > ATLAS) return null;
    if (this.px + w > ATLAS) { this.px = 0; this.py += this.rowH + 1; this.rowH = 0; }
    if (this.py + h > ATLAS) { this._resetAtlas(); } // atlas cheio → limpa (raro)
    const x = this.px, y = this.py;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.px += w + 1; if (h > this.rowH) this.rowH = h;
    uv = { u0: x / ATLAS, v0: y / ATLAS, u1: (x + w) / ATLAS, v1: (y + h) / ATLAS };
    this.atlas.set(key, uv); return uv;
  }
  _resetAtlas() { this.atlas.clear(); this.px = 0; this.py = 0; this.rowH = 0; }
  begin(w, h) {
    if (!this.ok) return; const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this.n = 0; this._w = w; this._h = h;
  }
  draw(src, key, dx, dy, dw, dh, alpha) {
    if (!this.ok || !src) return; const uv = this._ensure(key, src); if (!uv) return;
    if (this.n >= 4096) this._flush(); // lote cheio
    const o = this.n * 9, a = this.inst;
    a[o] = dx; a[o + 1] = dy; a[o + 2] = dw; a[o + 3] = dh;
    a[o + 4] = uv.u0; a[o + 5] = uv.v0; a[o + 6] = uv.u1; a[o + 7] = uv.v1; a[o + 8] = alpha == null ? 1 : alpha;
    this.n++;
  }
  _flush() {
    if (!this.n) return; const gl = this.gl; gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this._w, this._h); gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.subarray(0, this.n * 9), gl.DYNAMIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32); gl.vertexAttribDivisor(3, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    this.n = 0;
  }
  end() { if (this.ok) this._flush(); }
}
module.exports = MapGL;
