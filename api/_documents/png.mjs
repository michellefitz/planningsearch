import zlib from "node:zlib";

/**
 * Minimal PNG encoder — greyscale, 8-bit, no external dependency.
 *
 * A scanned council page is black ink on white paper: the colour channels
 * carry nothing, so one byte per pixel instead of four cuts the raw data to a
 * quarter before zlib ever sees it. zlib is a Node builtin, which is the whole
 * point — the serverless function stays dependency-free.
 */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA ImageData → greyscale PNG. */
export function greyPng({ width, height, data }) {
  // One filter byte per row, then one grey byte per pixel. Filter 1 (Sub)
  // beats None on scanned text by a wide margin: long runs of identical
  // pixels become long runs of zeroes.
  const raw = Buffer.alloc(height * (width + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 1;
    let prev = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Rec. 601 luma, integer.
      const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      raw[p++] = (g - prev) & 0xff;
      prev = g;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
