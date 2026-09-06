// Geometric, code-native app mark; no external assets or fonts.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
for (const [size, name] of [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * 512, v = y / size * 512;
    const radius = Math.hypot(u - 256, v - 238);
    const arch = (v < 238 && radius <= 144 && radius >= 84) || (v >= 238 && v < 344 && ((u >= 112 && u < 172) || (u >= 340 && u < 400)));
    const bridge = v >= 352 && v < 388 && u >= 88 && u < 424;
    const color = bridge ? [134, 182, 164] : arch ? [245, 244, 234] : [33, 60, 54];
    const offset = y * (1 + size * 4) + 1 + x * 4;
    raw.set([...color, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(new URL('../public/' + name, import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
