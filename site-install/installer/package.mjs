import { Package, logicalImage, sha256hex, validateStockPackage } from './fm1pkg.js?v=installer-20261116.1';
import { bkCrc } from './fm1backup.js?v=installer-20261116.1';

export function requireCheck(condition, reason) {
  if (!condition) throw new Error(reason);
}
const text = bytes => String.fromCharCode(...bytes);

export async function validateTarget(bytes, meta, kind) {
  requireCheck(bytes.length === meta.bytes && await sha256hex(bytes) === meta.sha256, 'Package checksum failed.');
  if (kind === 'stock') await validateStockPackage(bytes);
  const pack = new Package(bytes);
  requireCheck(pack.product === meta.product, 'Package identity failed.');
  if (kind === 'jazzy') {
    const flash = pack.flash;
    const marker = flash.subarray(0x93000, 0x93020);
    const view = new DataView(marker.buffer, marker.byteOffset, marker.byteLength);
    requireCheck(flash.length === 0xdc000 && text(marker.subarray(0, 8)) === 'RHYBRK1\0' &&
      view.getUint32(8, true) === 4 && view.getUint32(12, true) === 0xa0000 &&
      view.getUint32(16, true) === 0xc8000 && view.getUint32(20, true) === 0x14000 &&
      view.getUint32(24, true) === 2 && bkCrc(marker.subarray(0, 28)) === view.getUint32(28, true),
      'The expected embedded Break-bank layout is missing.');
    for (const [index, offset] of [0xa0000, 0xb4000].entries()) {
      const header = new DataView(flash.buffer, flash.byteOffset + offset, 512);
      const pcm = flash.subarray(offset + 512, offset + 72512);
      requireCheck(text(flash.subarray(offset, offset + 7)) === 'FSMP\x0c\0\x01' &&
        header.getUint32(16, true) === 72000 && bkCrc(pcm) === header.getUint32(20, true) &&
        await sha256hex(pcm) === meta.breaks[index], 'An embedded Break sample failed validation.');
    }
  }
  return { product: pack.product, image: logicalImage(bytes), sha256: meta.sha256 };
}

export function isSupportedSource(id, name, target) {
  if (id === 'FM-1_015' || id === 'FM-1_016') return true;
  if (id === 'FM-1_900' && /^(?:JAZZY|Rhythmer)(?: |$)/.test(name)) return true;
  if (/^FM-1_748[0-9]{3}$/.test(id) && /^Rhythmer(?: |$)/.test(name)) return true;
  return target === 'stock' && id === 'FM-1_016';
}
