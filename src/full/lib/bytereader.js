// Leitor little-endian sobre Buffer (formato Tibia .dat/.spr).
class ByteReader {
  constructor(buf, p = 0) { this.b = buf; this.p = p; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  str() { const n = this.u16(); const s = this.b.toString('latin1', this.p, this.p + n); this.p += n; return s; }
  skip(n) { this.p += n; }
  seek(n) { this.p = n; }
}
module.exports = ByteReader;
