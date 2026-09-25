import { StringDecoder } from "node:string_decoder";
import { Transform, type TransformCallback } from "node:stream";
import type { SseSignatureExtractor } from "./extract.js";

/**
 * Byte-transparent SSE tap. Every chunk is forwarded downstream UNMODIFIED
 * while a UTF-8-safe view of the same bytes feeds the signature extractor.
 *
 * - `callback(null, chunk)` keeps Node's built-in backpressure intact.
 * - StringDecoder reassembles multi-byte characters split across TCP chunks.
 * - Extraction errors are trapped: parsing is best-effort and must never
 *   break the user's completion stream.
 *
 * Lifecycle (AbortController, res) is owned by the route handler, not here.
 */
export class SignatureTap extends Transform {
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly extractor: SseSignatureExtractor) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const text = this.decoder.write(chunk);
      if (text) this.extractor.feed(text);
    } catch (err) {
      console.warn("[proxy] signature extraction error (stream continues):", err);
    }
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    try {
      const tail = this.decoder.end();
      if (tail) this.extractor.feed(tail);
      this.extractor.finish();
    } catch (err) {
      console.warn("[proxy] signature finish error (stream completes):", err);
    }
    callback();
  }
}
