/**
 * @fileoverview Audio capture and processing using AudioWorklet.
 * Captures microphone audio as PCM-16 mono 16 kHz chunks.
 */

/** @constant {number} Target sample rate */
const TARGET_SAMPLE_RATE = 16000;
/** @constant {number} Chunk duration in milliseconds */
const CHUNK_DURATION_MS = 160; // ~160ms → 2560 samples at 16kHz
/** @constant {number} Samples per chunk */
const SAMPLES_PER_CHUNK = Math.floor(TARGET_SAMPLE_RATE * CHUNK_DURATION_MS / 1000);

/**
 * AudioWorklet processor code (inlined as a Blob URL).
 * Buffers float32 samples and emits PCM-16 chunks.
 */
const WORKLET_CODE = `
class PCMChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._chunkSize = ${SAMPLES_PER_CHUNK};
    this._muted = false;

    this.port.onmessage = (e) => {
      if (e.data.type === 'mute') this._muted = true;
      if (e.data.type === 'unmute') this._muted = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono

    if (this._muted) {
      // Send silence when muted
      const silence = new Float32Array(channelData.length);
      this._appendAndFlush(silence);
    } else {
      this._appendAndFlush(channelData);
    }

    return true;
  }

  _appendAndFlush(samples) {
    // Append new samples to buffer
    const newBuf = new Float32Array(this._buffer.length + samples.length);
    newBuf.set(this._buffer);
    newBuf.set(samples, this._buffer.length);
    this._buffer = newBuf;

    // Flush complete chunks
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this._buffer = this._buffer.slice(this._chunkSize);

      // Convert Float32 → Int16
      const pcm16 = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Compute RMS amplitude (0-1) for lip-sync
      let sumSq = 0;
      for (let i = 0; i < this._chunkSize; i++) {
        sumSq += chunk[i] * chunk[i];
      }
      const rms = Math.sqrt(sumSq / this._chunkSize);

      this.port.postMessage({ type: 'chunk', buffer: pcm16.buffer, rms }, [pcm16.buffer]);
    }
  }
}

registerProcessor('pcm-chunk-processor', PCMChunkProcessor);
`;

class AudioProcessor {
  constructor() {
    /** @private @type {AudioContext|null} */ this._audioCtx = null;
    /** @private @type {MediaStream|null} */ this._stream = null;
    /** @private @type {AudioWorkletNode|null} */ this._workletNode = null;
    /** @private @type {MediaStreamAudioSourceNode|null} */ this._sourceNode = null;
    /** @private */ this._onChunk = null;
    /** @private */ this._onAmplitude = null;
    /** @private */ this._muteTimer = null;
  }

  /**
   * Initialise microphone and AudioWorklet.
   * Must be called after a user gesture.
   */
  async init() {
    // Request microphone
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: TARGET_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create AudioContext at target sample rate
    this._audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

    // Register worklet processor from Blob URL
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await this._audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    // Create nodes
    this._sourceNode = this._audioCtx.createMediaStreamSource(this._stream);
    this._workletNode = new AudioWorkletNode(this._audioCtx, 'pcm-chunk-processor');

    // Handle chunks from worklet
    this._workletNode.port.onmessage = (event) => {
      if (event.data.type === 'chunk') {
        if (this._onChunk) this._onChunk(event.data.buffer);
        if (this._onAmplitude) this._onAmplitude(event.data.rms || 0);
      }
    };

    console.log('[Audio] Initialised — sample rate:', this._audioCtx.sampleRate);
  }

  /**
   * Start audio capture.
   */
  start() {
    if (!this._sourceNode || !this._workletNode) {
      throw new Error('AudioProcessor not initialised. Call init() first.');
    }
    this._sourceNode.connect(this._workletNode);
    // Don't connect worklet to destination (we don't want to hear ourselves)
    console.log('[Audio] Capture started');
  }

  /**
   * Stop audio capture.
   */
  stop() {
    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch { /* ignore */ }
    }
    console.log('[Audio] Capture stopped');
  }

  /**
   * Mute microphone for a duration (echo prevention during TTS playback).
   * @param {number} ms - Duration in milliseconds
   */
  muteDuring(ms) {
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'mute' });
      if (this._muteTimer) clearTimeout(this._muteTimer);
      this._muteTimer = setTimeout(() => {
        if (this._workletNode) {
          this._workletNode.port.postMessage({ type: 'unmute' });
        }
      }, ms);
    }
  }

  /**
   * Register callback for PCM-16 audio chunks.
   * @param {function(ArrayBuffer):void} callback - Receives PCM-16 Int16Array buffer
   */
  onChunk(callback) {
    this._onChunk = callback;
  }

  /**
   * Register callback for audio amplitude (RMS 0-1).
   * Called on each chunk, can be used for lip-sync.
   * @param {function(number):void} callback
   */
  onAmplitude(callback) {
    this._onAmplitude = callback;
  }

  /**
   * Release all resources.
   */
  destroy() {
    this.stop();
    if (this._muteTimer) clearTimeout(this._muteTimer);
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
    }
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close();
    }
    this._audioCtx = null;
    this._stream = null;
    this._workletNode = null;
    this._sourceNode = null;
  }

  /** @returns {AudioContext|null} */
  get audioContext() {
    return this._audioCtx;
  }
}

export default AudioProcessor;
