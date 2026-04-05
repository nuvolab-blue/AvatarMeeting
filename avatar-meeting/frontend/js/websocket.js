/**
 * @fileoverview WebSocket communication manager for lip-sync avatar streaming.
 * Handles connection lifecycle, auto-reconnect, heartbeat, and message routing.
 */

class AvatarWebSocket {
  /**
   * @param {string} url - WebSocket endpoint (e.g. wss://localhost:8443/ws/lipsync)
   */
  constructor(url) {
    /** @private */ this._url = url;
    /** @private @type {WebSocket|null} */ this._ws = null;
    /** @private */ this._reconnectDelay = 1000;
    /** @private */ this._maxReconnectDelay = 30000;
    /** @private */ this._heartbeatInterval = null;
    /** @private */ this._shouldReconnect = true;
    /** @private @type {ArrayBuffer[]} */ this._sendQueue = [];

    // Callbacks
    /** @private */ this._onAudioChunk = null;
    /** @private */ this._onFrames = null;
    /** @private */ this._onDone = null;
    /** @private */ this._onError = null;
    /** @private */ this._onReconnect = null;

    // Time sync
    /** @private */ this._timeOffset = 0;
  }

  /**
   * Establish WebSocket connection.
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this._url);
        this._ws.binaryType = 'arraybuffer';

        this._ws.onopen = () => {
          console.log('[WS] Connected to', this._url);
          this._reconnectDelay = 1000;
          this._startHeartbeat();
          this._flushQueue();
          resolve();
        };

        this._ws.onmessage = (event) => this._handleMessage(event);

        this._ws.onclose = (event) => {
          console.log('[WS] Closed:', event.code, event.reason);
          this._stopHeartbeat();
          if (this._shouldReconnect) {
            this._scheduleReconnect();
          }
        };

        this._ws.onerror = (error) => {
          console.error('[WS] Error:', error);
          if (this._onError) this._onError(error);
          reject(error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a PCM-16 audio chunk as binary.
   * @param {ArrayBuffer} pcm16ArrayBuffer
   */
  sendAudioChunk(pcm16ArrayBuffer) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(pcm16ArrayBuffer);
    } else {
      this._sendQueue.push(pcm16ArrayBuffer);
    }
  }

  /**
   * Send a JSON configuration message.
   * @param {string} avatarId
   */
  sendConfig(avatarId) {
    this._sendJSON({ type: 'config', avatar_id: avatarId });
  }

  // ---- Callback setters ----

  /** @param {function({chunk_id:number, audio_b64:string, wall_start_time:number}):void} cb */
  onAudioChunk(cb) { this._onAudioChunk = cb; }

  /** @param {function({chunk_id:number, frames:string[]}):void} cb */
  onFrames(cb) { this._onFrames = cb; }

  /** @param {function({chunk_id:number}):void} cb */
  onDone(cb) { this._onDone = cb; }

  /** @param {function(Error):void} cb */
  onError(cb) { this._onError = cb; }

  /** @param {function():void} cb */
  onReconnect(cb) { this._onReconnect = cb; }

  /**
   * Disconnect and stop reconnecting.
   */
  disconnect() {
    this._shouldReconnect = false;
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.close(1000, 'Client disconnect');
      this._ws = null;
    }
  }

  /** @returns {boolean} */
  get isConnected() {
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
  }

  // ---- Private methods ----

  /**
   * Route incoming WebSocket messages.
   * @private
   * @param {MessageEvent} event
   */
  _handleMessage(event) {
    if (typeof event.data === 'string') {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'audio':
            // Convert server wall_start_time to local reference
            data._localStartTime = this._serverTimeToLocal(data.wall_start_time);
            if (this._onAudioChunk) this._onAudioChunk(data);
            break;
          case 'frames':
            if (this._onFrames) this._onFrames(data);
            break;
          case 'done':
            if (this._onDone) this._onDone(data);
            break;
          case 'pong':
            // heartbeat response
            break;
          case 'config_ack':
            console.log('[WS] Avatar configured:', data.avatar_id);
            break;
          case 'error':
            console.error('[WS] Server error:', data.message);
            if (this._onError) this._onError(new Error(data.message));
            break;
          default:
            console.warn('[WS] Unknown message type:', data.type);
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    }
  }

  /**
   * Convert server wall time (Unix seconds) to local performance.now() reference.
   * @private
   * @param {number} serverTime - Unix timestamp in seconds
   * @returns {number} Approximate performance.now() value
   */
  _serverTimeToLocal(serverTime) {
    // performance.timeOrigin + performance.now() ≈ Date.now()
    const serverMs = serverTime * 1000;
    const localNow = performance.now();
    const localWallNow = performance.timeOrigin + localNow;
    const offset = localWallNow - serverMs;
    return localNow - offset + (localWallNow - serverMs);
  }

  /**
   * Send queued messages after reconnect.
   * @private
   */
  _flushQueue() {
    while (this._sendQueue.length > 0 && this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(this._sendQueue.shift());
    }
  }

  /**
   * Send a JSON message.
   * @private
   * @param {object} obj
   */
  _sendJSON(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Start heartbeat ping every 30 seconds.
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      this._sendJSON({ type: 'ping' });
    }, 30000);
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    const delay = this._reconnectDelay;
    console.log(`[WS] Reconnecting in ${delay}ms...`);
    setTimeout(async () => {
      try {
        await this.connect();
        if (this._onReconnect) this._onReconnect();
      } catch {
        // connect() failed, onclose will trigger another attempt
      }
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }
}

export default AvatarWebSocket;
