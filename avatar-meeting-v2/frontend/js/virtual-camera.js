/**
 * @fileoverview Virtual camera output via Insertable Streams or captureStream.
 *
 * Replaces the real camera feed with the avatar canvas output.
 * Supports:
 *  1. Insertable Streams API (preferred — works with Meet/Slack)
 *  2. captureStream fallback
 */

class VirtualCamera {
  /**
   * @param {HTMLCanvasElement} avatarCanvas
   */
  constructor(avatarCanvas) {
    /** @private */ this._canvas = avatarCanvas;
    /** @private */ this._stream = null;
    /** @private */ this._realStream = null;
    /** @private */ this._active = false;
    /** @private */ this._generator = null;
    /** @private */ this._processor = null;
  }

  /** @type {boolean} */
  get isActive() { return this._active; }

  /**
   * Start virtual camera.
   * @returns {Promise<MediaStream>}
   */
  async start() {
    // Try Insertable Streams first
    if (this._supportsInsertableStreams()) {
      try {
        return await this._startInsertable();
      } catch (e) {
        console.warn('[VirtualCamera] Insertable Streams failed, falling back:', e);
      }
    }

    // Fallback: captureStream
    console.warn('[VirtualCamera] Using captureStream fallback');
    return this._startCapture();
  }

  /** Stop virtual camera. */
  stop() {
    this._active = false;
    if (this._realStream) {
      this._realStream.getTracks().forEach((t) => t.stop());
      this._realStream = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    window._avatarStream = null;
    console.log('[VirtualCamera] Stopped');
  }

  /** Toggle ON/OFF. */
  toggle() {
    this._active = !this._active;
    console.log('[VirtualCamera] %s', this._active ? 'ON' : 'OFF');
  }

  // ==========================================================================
  // Private: Insertable Streams
  // ==========================================================================

  /** @private */
  _supportsInsertableStreams() {
    return typeof MediaStreamTrackProcessor !== 'undefined' &&
           typeof MediaStreamTrackGenerator !== 'undefined';
  }

  /** @private */
  async _startInsertable() {
    // Get real camera (needed as base track)
    this._realStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = this._realStream.getVideoTracks()[0];

    const processor = new MediaStreamTrackProcessor({ track });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });

    this._processor = processor;
    this._generator = generator;
    this._active = true;

    const canvas = this._canvas;
    const self = this;

    const transformer = new TransformStream({
      async transform(frame, controller) {
        if (self._active) {
          try {
            const bitmap = await createImageBitmap(canvas);
            const newFrame = new VideoFrame(bitmap, {
              timestamp: frame.timestamp,
              duration: frame.duration,
            });
            controller.enqueue(newFrame);
            frame.close();
            bitmap.close();
          } catch {
            controller.enqueue(frame);
          }
        } else {
          controller.enqueue(frame);
        }
      },
    });

    processor.readable.pipeThrough(transformer).pipeTo(generator.writable);

    this._stream = new MediaStream([generator]);
    window._avatarStream = this._stream;

    console.log('[VirtualCamera] Started (Insertable Streams)');
    return this._stream;
  }

  // ==========================================================================
  // Private: captureStream fallback
  // ==========================================================================

  /** @private */
  _startCapture() {
    this._active = true;
    this._stream = this._canvas.captureStream(30);
    window._avatarStream = this._stream;

    console.log('[VirtualCamera] Started (captureStream)');
    return this._stream;
  }
}

export default VirtualCamera;

if (typeof window !== 'undefined') {
  window.VirtualCamera = VirtualCamera;
}
