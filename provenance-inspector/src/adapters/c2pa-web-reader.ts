// ProvenanceReader backed by the official C2PA SDK (c2pa-rs compiled to WebAssembly).
// The 9 MB binary is only downloaded when the first file is checked.

import { Context, createC2pa, Reader, type C2pa } from '@contentauth/c2pa-web';
import wasmSrc from '@contentauth/c2pa-web/resources/c2pa.wasm?url';
import type { ManifestStore, ProvenanceReader } from '../analyzers/provenance.js';

/** Official C2PA trust list (certificates of conforming signers such as Adobe, Google, OpenAI, camera makers). */
export const C2PA_TRUST_LIST = 'https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem';

export class C2paWebReader implements ProvenanceReader {
  private sdk: Promise<C2pa> | null = null;
  private trusted: Context | null = null;
  trustListLoaded: boolean | null = null;

  private init(): Promise<C2pa> {
    this.sdk ??= createC2pa({ wasmSrc });
    return this.sdk;
  }

  async read(bytes: Uint8Array, mime: string): Promise<ManifestStore | null> {
    try {
      return await this.readOrThrow(bytes, mime);
    } catch (err) {
      // Files the SDK cannot parse as a container carry no readable credentials.
      if (/InvalidAsset|UnsupportedType|JumbfNotFound|NotFound/i.test(String(err))) return null;
      throw err;
    }
  }

  private async readOrThrow(bytes: Uint8Array, mime: string): Promise<ManifestStore | null> {
    const c2pa = await this.init();
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
    if (this.trustListLoaded !== false) {
      try {
        this.trusted ??= new Context({ verify: { verifyTrust: true }, trust: { trustAnchors: C2PA_TRUST_LIST } });
        const reader = await Reader.fromBlob(c2pa, mime, blob, this.trusted);
        this.trustListLoaded = true;
        return reader ? ((await reader.json()) as ManifestStore) : null;
      } catch (err) {
        // Trust list unreachable (offline, blocked): fall back to signature checks without trust.
        if (!/trust|fetch|network/i.test(String(err))) throw err;
        this.trustListLoaded = false;
      }
    }
    const reader = await Reader.fromBlob(c2pa, mime, blob);
    return reader ? ((await reader.json()) as ManifestStore) : null;
  }
}
