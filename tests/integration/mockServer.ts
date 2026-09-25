import http from "node:http";
import type { AddressInfo } from "node:net";

/** One HTTP request as the mock upstream saw it. */
export class RecordedRequest {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly headers: http.IncomingHttpHeaders,
    public readonly rawBody: Buffer,
  ) {}
  get text(): string {
    return this.rawBody.toString("utf8");
  }
  get json(): unknown {
    const trimmed = this.text.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  }
}

export type ChatResponder = (
  recorded: RecordedRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

export interface SseOptions {
  /** Frame payloads: JSON strings, or the literal "[DONE]". */
  frames: string[];
  /** Frame terminator; real GFE fronts use CRLF. Default CRLF. */
  eol?: "\r\n\r\n" | "\n\n";
  /** Slice the FULL concatenated stream into N-byte writes. */
  sliceBytes?: number;
  /** setTimeout delay between writes (default: setImmediate yield). */
  delayMs?: number;
  /** Delay BEFORE response headers are written (simulates slow thinking). */
  headersDelayMs?: number;
  /** Destroy the socket after writing this many bytes (no [DONE]). */
  abortAfterBytes?: number;
}

/** Builds the exact byte payload respondSse will send, for assertions. */
export function renderSse(frames: string[], eol: "\r\n\r\n" | "\n\n" = "\r\n\r\n"): string {
  const lines = frames.map((f) => {
    if (f === "[DONE]") return "data: [DONE]";
    if (f.startsWith(":")) return f; // raw comment line (e.g. ": ping")
    return `data: ${f}`;
  });
  return lines.join(eol) + eol;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldLoop(): Promise<void> {
  // Lets the OS flush the TCP segment so slices arrive as separate chunks
  // without paying real clock time.
  return new Promise((resolve) => setImmediate(resolve));
}

/** SSE responder: sends frames exactly as renderSse() describes. */
export function respondSse(opts: SseOptions): ChatResponder {
  return async (_recorded, res) => {
    const eol = opts.eol ?? "\r\n\r\n";
    const full = Buffer.from(renderSse(opts.frames, eol), "utf8");
    const slices: Buffer[] = [];
    if (opts.sliceBytes !== undefined && opts.sliceBytes > 0) {
      for (let i = 0; i < full.length; i += opts.sliceBytes) {
        slices.push(full.subarray(i, i + opts.sliceBytes));
      }
    } else {
      slices.push(full);
    }

    if (opts.headersDelayMs !== undefined && opts.headersDelayMs > 0) {
      await sleep(opts.headersDelayMs);
    }
    // The client may have disconnected while we sat on headersDelayMs.
    if (res.destroyed || res.writableEnded) return;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    let written = 0;
    for (const slice of slices) {
      if (opts.abortAfterBytes !== undefined && written >= opts.abortAfterBytes) {
        res.destroy();
        return;
      }
      res.write(slice);
      written += slice.length;
      await (opts.delayMs !== undefined && opts.delayMs > 0 ? sleep(opts.delayMs) : yieldLoop());
    }
    res.end();
  };
}

/** JSON responder: sends the exact string bytes provided (no re-serialization). */
export function respondJson(
  bodyString: string,
  status = 200,
  headers: Record<string, string> = {},
): ChatResponder {
  return (_recorded, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(bodyString);
  };
}

export interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  setChatResponder(responder: ChatResponder | null): void;
  close(): Promise<void>;
}

/**
 * A deterministic stand-in for Google's OpenAI-compatible endpoint.
 * Records every request (raw bytes); chat completions route through a
 * programmable responder; everything else echoes.
 */
export function createMockUpstream(): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  let chatResponder: ChatResponder | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = new RecordedRequest(
        req.method ?? "",
        req.url ?? "",
        req.headers,
        Buffer.concat(chunks),
      );
      requests.push(recorded);

      const pathname = recorded.url.split("?")[0];
      // Canned route for the no-body status path: verifies the proxy ends
      // cleanly when upstream has no response body at all.
      if (pathname === "/no-content") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "POST" && pathname === "/v1beta/openai/chat/completions") {
        if (chatResponder) {
          void Promise.resolve(chatResponder(recorded, res)).catch(() => res.destroy());
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no chat responder configured" }));
        }
        return;
      }

      // Generic echo for passthrough assertions.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          echo: true,
          method: recorded.method,
          url: recorded.url,
          body: recorded.text,
          contentType: recorded.headers["content-type"] ?? null,
        }),
      );
    });
    req.on("error", () => {
      // Client aborted mid-upload; nothing to do.
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        setChatResponder: (responder) => {
          chatResponder = responder;
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
