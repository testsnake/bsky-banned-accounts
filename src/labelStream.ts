import WebSocket from "ws";
import { decodeMultiple } from "cbor-x";
import { logger } from "./logger";

export interface LabelStreamHeader {
    op: number; // 1 = message, -1 = error
    t: "#labels" | "#info";
}

export interface Label {
    ver?: number;
    src: string;        // DID of the labeler
    uri: string;        // DID or at:// URI of the labeled subject
    cid?: string;       // specific CID (if record-level)
    val: string;        // label value e.g. "!takedown", "spam"
    neg?: boolean;      // true = negation (removing the label)
    cts: string;        // ISO 8601 creation timestamp
    exp?: string;       // ISO 8601 expiry timestamp
    sig?: Uint8Array;   // labeler signature
}

export interface LabelsBody {
    seq: number;
    labels: Label[];
}

export interface InfoBody {
    name: string;
    message?: string;
}

export interface LabelStreamErrorBody {
    error: string;
    message?: string;
}

export interface LabelStreamOptions {
    cursor?: number;
    onTakedown: (did: string, banned: boolean, src: string, label: Label) => Promise<void>;
    onError?: (error: Error) => void;
    onReconnect?: (attempt: number, delay: number) => void;
    allowedLabelers?: string[];
}

const LABEL_STREAM_BASE_URL = "wss://mod.bsky.app/xrpc/com.atproto.label.subscribeLabels";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class LabelStream {
    private readonly onTakedown: LabelStreamOptions["onTakedown"];
    private readonly onError: NonNullable<LabelStreamOptions["onError"]>;
    private readonly onReconnect: NonNullable<LabelStreamOptions["onReconnect"]>;

    private ws: WebSocket | null = null;
    private stopped = false;
    private reconnectAttempt = 0;
    private cursor: number;
    private allowedLabelers: Set<string>;

    constructor(options: LabelStreamOptions) {
        this.cursor = options.cursor ?? -1;
        this.allowedLabelers = new Set(options.allowedLabelers ?? []);
        this.onTakedown = options.onTakedown;
        this.onError = options.onError ?? ((e) => console.error("[LabelStream]", e));
        this.onReconnect = options.onReconnect ?? ((attempt, delay) =>
            console.log(`[LabelStream] reconnecting in ${delay}ms (attempt ${attempt})…`)
        );
    }

    get currentCursor(): number {
        return this.cursor;
    }

    setCursor(cursor: number): void {
        this.cursor = cursor;
    }

    addLabeler(did: string): void {
        this.allowedLabelers.add(did);
    }

    removeLabeler(did: string): void {
        this.allowedLabelers.delete(did);
    }

    get labelers(): string[] {
        return [...this.allowedLabelers];
    }

    start(): void {
        if (this.ws) return;
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.ws?.close();
        this.ws = null;
        console.log("[LabelStream] stopped");
    }

    private isAllowedLabeler(src: string): boolean {
        // If no filter is set, allow all labelers
        if (this.allowedLabelers.size === 0) return true;
        return this.allowedLabelers.has(src);
    }

    private buildUrl(): string {
        if (this.cursor < 0) {
            return LABEL_STREAM_BASE_URL;
        }
        return `${LABEL_STREAM_BASE_URL}?cursor=${this.cursor}`;
    }

    private connect(): void {
        if (this.stopped) return;

        const url = this.buildUrl();
        console.log(`[LabelStream] connecting to ${url}`);
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on("open", () => {
            console.log("[LabelStream] connected");
            this.reconnectAttempt = 0;
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

            const frames: unknown[] = [];
            decodeMultiple(buf, (v) => frames.push(v));
            if (frames.length < 2) return;

            const [header, body] = frames as [LabelStreamHeader, LabelsBody | InfoBody | LabelStreamErrorBody];

            if (header.op === -1) {
                const err = body as LabelStreamErrorBody;
                this.onError(new Error(`${err.error}: ${err.message}`));
                return;
            }

            if (header.t === "#info") {
                const info = body as InfoBody;
                logger.info(`[LabelStream] info: ${info.name}${info.message ? ` — ${info.message}` : ""}`);
                return;
            }

            if (header.t === "#labels") {
                const { seq, labels } = body as LabelsBody;
                this.cursor = seq;

                for (const label of labels ?? []) {
                    if (!this.isAllowedLabeler(label.src)) continue;

                    // logger.debug({ label }, "Received label");
                    // console.log(`[LabelStream] [${label.src}] ${label.uri} ${label.neg ? "UNLABELED" : "LABELED"} with "${label.val}"`);


                    const did = label.uri;
                    const banned = !label.neg;
                    this.onTakedown(did, banned, label.src, label).catch((err) =>
                        this.onError(err instanceof Error ? err : new Error(String(err)))
                    );
                }
            }
        });

        ws.on("close", (code) => {
            logger.warn(`[LabelStream] disconnected (code=${code})`);
            this.scheduleReconnect();
        });

        ws.on("error", (err) => {
            this.onError(err instanceof Error ? err : new Error(String(err)));
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
        this.onReconnect(this.reconnectAttempt, delay);
        this.reconnectAttempt++;
        setTimeout(() => this.connect(), delay);
    }
}