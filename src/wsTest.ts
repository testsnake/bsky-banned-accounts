import WebSocket from "ws";
import { decodeMultiple } from "cbor-x";

const LABEL_STREAM_URL =
  "wss://mod.bsky.app/xrpc/com.atproto.label.subscribeLabels";

export function subscribeLabelStream() {
  const ws = new WebSocket(LABEL_STREAM_URL);

  ws.on("open", () => {
    console.log("[LabelStream] connected");
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let buf: Uint8Array;
    if (Array.isArray(data)) {
      buf = new Uint8Array(Buffer.concat(data));
    } else if (data instanceof ArrayBuffer) {
      buf = new Uint8Array(data);
    } else {
      buf = new Uint8Array(data as Buffer);
    }

    const frames: any[] = [];
    decodeMultiple(buf, (v) => frames.push(v));
    if (frames.length < 2) return;

    const [header, body] = frames;
    if (header.op !== 1 || header.t !== "#labels") return;

    for (const label of body.labels ?? []) {
      if (label.val !== "!takedown") continue;

      const did = label.uri;
      const banned = !label.neg;
      console.log(`[LabelStream] ${did} was ${banned ? "BANNED" : "UNBANNED"}`);
    }
  });

  ws.on("close", (code) => {
    console.warn(`[LabelStream] disconnected (code=${code}), reconnecting in 5s…`);
    setTimeout(subscribeLabelStream, 5_000);
  });

  ws.on("error", (err) => {
    console.error("[LabelStream] error:", err);
  });
}

if (require.main === module) {
  subscribeLabelStream();
}