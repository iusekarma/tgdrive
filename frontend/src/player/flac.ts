/** A small FLAC encoder. Audio the browser can't play (AC-3, DTS, PCM) is
 * decoded here and handed to it as FLAC, the one lossless format Media Source
 * takes everywhere. WebCodecs could make Opus instead, but only over HTTPS,
 * and tgdrive is often opened over plain HTTP on a home network. */

export const FLAC_BLOCK = 4096;

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let a = i;
  let b = i << 8;
  for (let k = 0; k < 8; k++) {
    a = a & 0x80 ? (a << 1) ^ 0x07 : a << 1;
    b = b & 0x8000 ? (b << 1) ^ 0x8005 : b << 1;
  }
  CRC8[i] = a;
  CRC16[i] = b;
}

class BitWriter {
  private out: Uint8Array<ArrayBuffer>;
  private length = 0;
  private acc = 0;
  private bits = 0;
  constructor(capacity: number) {
    this.out = new Uint8Array(capacity);
  }
  private byte(b: number) {
    if (this.length === this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.length++] = b;
  }
  /** Up to 16 bits at a time. */
  put(value: number, n: number) {
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.byte((this.acc >> this.bits) & 0xff);
    }
    this.acc &= (1 << this.bits) - 1;
  }
  unary(q: number) {
    for (; q >= 16; q -= 16) this.put(0, 16);
    this.put(1, q + 1);
  }
  align() {
    if (this.bits) this.put(0, 8 - this.bits);
  }
  done() {
    return this.out.subarray(0, this.length);
  }
}

/** "fLaC" and STREAMINFO, which is what decoders are configured with. */
export function flacDescription(sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(42);
  const view = new DataView(out.buffer);
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  view.setUint16(8, FLAC_BLOCK);
  view.setUint16(10, FLAC_BLOCK);
  // Rate (20 bits), channels - 1 (3), bits per sample - 1 (5), then the length, unknown.
  view.setUint32(18, (sampleRate << 12) | ((channels - 1) << 9) | (15 << 4));
  return out;
}

/** One frame of 16-bit samples; each channel exactly FLAC_BLOCK long. */
export function flacFrame(channels: Int16Array[], index: number): Uint8Array<ArrayBuffer> {
  const w = new BitWriter(FLAC_BLOCK * channels.length * 2);
  w.put(0xfff8, 16); // sync, fixed block size
  w.put(0b1100, 4); // 4096 samples
  w.put(0, 4); // rate: from STREAMINFO
  w.put(channels.length - 1, 4);
  w.put(0b1000, 4); // 16 bits, then a reserved bit
  for (const b of utf8(index)) w.put(b, 8);
  let crc8 = 0;
  for (const b of w.done()) crc8 = CRC8[crc8 ^ b];
  w.put(crc8, 8);
  for (const pcm of channels) subframe(w, pcm);
  w.align();
  let crc16 = 0;
  for (const b of w.done()) crc16 = ((crc16 << 8) & 0xffff) ^ CRC16[(crc16 >> 8) ^ b];
  w.put(crc16, 16);
  return w.done().slice();
}

/** Second-order prediction, Rice coded; stored plainly if that comes out larger. */
function subframe(w: BitWriter, pcm: Int16Array) {
  const n = pcm.length;
  const residual = new Uint32Array(n - 2);
  let sum = 0;
  for (let i = 2; i < n; i++) {
    const r = pcm[i] - 2 * pcm[i - 1] + pcm[i - 2];
    const folded = r >= 0 ? r * 2 : -r * 2 - 1;
    residual[i - 2] = folded;
    sum += folded;
  }
  const k = Math.min(14, Math.max(0, Math.ceil(Math.log2((sum / residual.length) * 0.7 + 1e-9))));
  let size = residual.length * (k + 1);
  for (const r of residual) size += r >>> k;
  if (size >= n * 16) {
    w.put(0b00000010, 8);
    for (const s of pcm) w.put(s, 16);
    return;
  }
  w.put(0b00010100, 8); // fixed predictor, order 2
  w.put(pcm[0], 16);
  w.put(pcm[1], 16);
  w.put(0, 2); // Rice, one partition
  w.put(0, 4);
  w.put(k, 4);
  for (const r of residual) {
    w.unary(r >>> k);
    if (k) w.put(r, k);
  }
}

function utf8(v: number): number[] {
  if (v < 0x80) return [v];
  let extra = 1;
  while (v >= 2 ** (6 * extra + (6 - extra))) extra += 1;
  const bytes = [];
  for (let i = extra; i > 0; i--) bytes.unshift(0x80 | (Math.floor(v / 64 ** (extra - i)) & 0x3f));
  bytes.unshift(((0xff00 >> (extra + 1)) & 0xff) | Math.floor(v / 64 ** extra));
  return bytes;
}
