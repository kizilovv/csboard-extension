/**
 * Narrow compatibility declaration for @hpke/core 1.9.0.
 *
 * The published 1.9.0 package currently references `esm/mod.d.ts` but ships
 * only `mod.d.ts.map`. Keep this surface intentionally limited to the APIs
 * used by gateway-crypto.ts and remove it once upstream ships the declaration.
 */
declare module '@hpke/core' {
  interface Kem {
    importKey(
      format: 'jwk',
      key: JsonWebKey,
      isPublic?: boolean,
    ): Promise<CryptoKey>;
  }

  interface SenderContext {
    readonly enc: ArrayBuffer;
    seal(
      plaintext: ArrayBufferLike | ArrayBufferView,
      aad?: ArrayBufferLike | ArrayBufferView,
    ): Promise<ArrayBuffer>;
  }

  export class Aes256Gcm {}
  export class HkdfSha256 {}
  export class DhkemX25519HkdfSha256 {}

  export class CipherSuite {
    constructor(options: {
      kem: DhkemX25519HkdfSha256;
      kdf: HkdfSha256;
      aead: Aes256Gcm;
    });
    readonly kem: Kem;
    createSenderContext(options: {
      recipientPublicKey: CryptoKey;
      info?: ArrayBufferLike | ArrayBufferView;
    }): Promise<SenderContext>;
  }
}
