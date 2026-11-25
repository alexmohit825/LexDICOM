/// <reference types="vite/client" />

declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    decode(buffer: ArrayBuffer, offset?: number, length?: number, numBytes?: number): ArrayBuffer;
  }
}
