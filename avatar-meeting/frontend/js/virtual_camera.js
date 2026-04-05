/**
 * @fileoverview Virtual camera using Chrome Insertable Streams API.
 * Replaces real camera frames with avatar canvas frames for use in Meet/Slack.
 */

class VirtualCamera {
  /**
   * @param {HTMLCanvasElement} avatarCanvas - The avatar rendering canvas
   */
  constructor(avatarCanvas) {
    /** @private */ this._canvas = avatarCanvas;
    /** @private */ this._active = false;
    /** @private @type {MediaStream|null} */ this._outputStream = null;
    /** @private @type {MediaStreamTrackProcessor|null} */ this._processor = null;
    /** @private @type {MediaStreamTrackGenerator|null} */ this._generator = null;
    /** @private @type {ReadableStreamDefaultReader|null} */ this._reader = null;
    /** @private */ this._abortController = null;
  }

  /**
   * Start the virtual camera. Returns a MediaStream that outputs avatar frames.
   * @returns {Promise<MediaStream>}
   */
  async start() {
    // Check Insertable Streams API support
    if (typeof MediaStreamTrackProcessor === 'undefined' ||
        typeof MediaStreamTrackGenerator === 'undefined') {
      console.warn('[VirtualCamera] Insertable Streams API not supported. Using captureStream fallback.');
      this._active = true;
      this._outputStream = this._canvas.captureStream(30);
      return this._outputStream;
    }

    // Get real camera track
    const realStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 30 },
    });
    const videoTrack = realStream.getVideoTracks()[0];

    // Set up Insertable Streams pipeline
    this._processor = new MediaStreamTrackProcessor({ track: videoTrack });
    this._generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this._abortController = new AbortController();

    const transformer = new TransformStream({
      transform: async (videoFrame, controller) => {
        try {
          if (this._active) {
            // Replace frame with avatar canvas content
            const avatarBitmap = await createImageBitmap(this._canvas);
            const newFrame = new VideoFrame(avatarBitmap, {
              timestamp: videoFrame.timestamp,
              duration: videoFrame.duration,
            });
            controller.enqueue(newFrame);
            videoFrame.close();
            avatarBitmap.close();
          } else {
            // Pass through original frame
            controller.enqueue(videoFrame);
          }
        } catch (err) {
          // On error, pass original frame
          try { controller.enqueue(videoFrame); } catch { videoFrame.close(); }
        }
      },
    });

    // Connect pipeline
    this._processor.readable
      .pipeThrough(transformer, { signal: this._abortController.signal })
      .pipeTo(this._generator.writable)
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('[VirtualCamera] Pipeline error:', err);
        }
      });

    this._active = true;
    this._outputStream = new MediaStream([this._generator]);

    console.log('[VirtualCamera] Started with Insertable Streams');
    return this._outputStream;
  }

  /**
   * Stop the virtual camera and clean up.
   */
  stop() {
    this._active = false;

    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    if (this._outputStream) {
      this._outputStream.getTracks().forEach((t) => t.stop());
      this._outputStream = null;
    }

    this._processor = null;
    this._generator = null;

    console.log('[VirtualCamera] Stopped');
  }

  /**
   * Toggle virtual camera on/off.
   * @returns {Promise<MediaStream|null>}
   */
  async toggle() {
    if (this._active) {
      this.stop();
      return null;
    }
    return this.start();
  }

  /** @returns {boolean} */
  get isActive() {
    return this._active;
  }

  /** @returns {MediaStream|null} */
  get stream() {
    return this._outputStream;
  }
}

export default VirtualCamera;
