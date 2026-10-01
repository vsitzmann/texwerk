import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { MSG_AWARENESS, MSG_SYNC, type ServerEvent } from './protocol.ts';

/**
 * A minimal Yjs WebSocket provider shared by the browser client and the
 * mirror bridge (Node 22+ has a global WebSocket). Reconnects with backoff,
 * re-syncs on every connect, and forwards JSON events to `onEvent`.
 */
export interface ProviderOptions {
  url: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  onEvent?: (event: ServerEvent) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected', detail?: string) => void;
  onSynced?: () => void;
  /**
   * The server's document was reloaded since this client last synced (its
   * epoch changed). The provider has stopped; the local doc must be replaced.
   */
  onReset?: () => void;
  /** Extra constructor arg for Node's WebSocket (headers). */
  wsOptions?: unknown;
}

export class Provider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  synced = false;
  /** Epoch of the server document this client's state belongs to. */
  epoch: string | null = null;
  private ws: WebSocket | null = null;
  private helloSeen = false;
  private closed = false;
  private backoff = 300;
  private readonly opts: ProviderOptions;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;

  constructor(opts: ProviderOptions) {
    this.opts = opts;
    this.doc = opts.doc;
    this.awareness = opts.awareness;
    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    };
    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.send(encoding.toUint8Array(enc));
    };
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.opts.onStatus?.('connecting');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new (WebSocket as any)(this.opts.url, this.opts.wsOptions) as WebSocket;
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.helloSeen = false;
    ws.onopen = () => {
      this.backoff = 300;
      this.opts.onStatus?.('connected');
      // Nothing is sent until the server's hello says which document epoch
      // it has: syncing state from an older epoch would duplicate content.
    };
    ws.onmessage = (message: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof message.data === 'string') {
        let event: ServerEvent;
        try {
          event = JSON.parse(message.data) as ServerEvent;
        } catch (err) {
          console.error('bad server event', err);
          return;
        }
        if (event.t === 'hello') {
          if (this.epoch !== null && event.epoch !== this.epoch) {
            this.closed = true;
            this.ws = null;
            ws.close();
            this.opts.onReset?.();
            return;
          }
          this.epoch = event.epoch;
          this.helloSeen = true;
          this.opts.onEvent?.(event);
          this.startSync();
          return;
        }
        this.opts.onEvent?.(event);
        return;
      }
      if (!this.helloSeen) return;
      this.handleBinary(new Uint8Array(message.data as ArrayBuffer));
    };
    ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.synced = false;
      // Everyone else's carets are stale once we can no longer hear about them.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID),
        this,
      );
      if (this.closed) return;
      this.opts.onStatus?.('disconnected', event.reason || undefined);
      // 4403/4404: permission or missing project — retrying will not help.
      if (event.code === 4403 || event.code === 4404) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private startSync(): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(encoding.toUint8Array(enc));
    if (this.awareness.getLocalState() !== null) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      this.send(encoding.toUint8Array(aw));
    }
  }

  private handleBinary(data: Uint8Array): void {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.opts.onSynced?.();
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
    }
  }

  /** Where the next (re)connect goes — the project was renamed. */
  setUrl(url: string): void {
    this.opts.url = url;
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === 1 && this.helloSeen) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  destroy(): void {
    this.closed = true;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.ws?.close();
  }
}
