// Byte helpers shared by the analyzers. Files are untrusted input: every read is bounds-checked.

export function startsWith(b: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

export function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = Math.max(0, start); i < Math.min(b.length, end); i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Latin-1 view of a region, used to search for PDF keywords and text markers cheaply. */
export function latin1(b: Uint8Array, start = 0, end = b.length): string {
  const chunk = 0x8000;
  let s = '';
  for (let i = Math.max(0, start); i < Math.min(b.length, end); i += chunk) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + chunk, end)));
  }
  return s;
}

export function u16be(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw new RangeError('read past end of file');
  return (b[o]! << 8) | b[o + 1]!;
}

export function u32be(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new RangeError('read past end of file');
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

export function u32le(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new RangeError('read past end of file');
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export function lastIndexOf(b: Uint8Array, sig: readonly number[], from = b.length - sig.length): number {
  for (let i = Math.min(from, b.length - sig.length); i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
