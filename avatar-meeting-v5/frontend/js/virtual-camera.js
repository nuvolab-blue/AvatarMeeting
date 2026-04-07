/**
 * @fileoverview Virtual Camera output via canvas.captureStream().
 *
 * Captures the Three.js canvas as a MediaStream and stores it
 * on window._avatarStream for use with OBS Virtual Camera.
 *
 * Note: Browsers cannot directly register as OS-level virtual cameras.
 * To use in Meet/Slack, combine with OBS Studio + OBS Virtual Camera plugin.
 */

export class VirtualCamera {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;
    /** @type {MediaStream|null} */
    this._stream = null;
  }

  /**
   * Start capturing the canvas as a MediaStream.
   * @param {number} fps - Frames per second (default 30)
   * @returns {MediaStream}
   */
  start(fps = 30) {
    this._stream = this._canvas.captureStream(fps);
    window._avatarStream = this._stream;
    console.log('[VirtualCamera] Stream started:', this._stream.id);
    return this._stream;
  }

  /** Stop the stream and clean up. */
  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    window._avatarStream = null;
    console.log('[VirtualCamera] Stream stopped');
  }

  /** @type {boolean} */
  get isActive() {
    return !!this._stream;
  }
}
