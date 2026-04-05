/**
 * @fileoverview Speech-to-text using Web Speech API (SpeechRecognition).
 * Provides continuous transcription for emotion analysis input.
 */

class WhisperSTT {
  constructor() {
    /** @private @type {SpeechRecognition|null} */ this._recognition = null;
    /** @private */ this._onText = null;
    /** @private */ this._isRunning = false;
    /** @private */ this._language = 'ja-JP';
  }

  /**
   * Initialise the speech recognition engine.
   * @param {object} [options]
   * @param {string} [options.language='ja-JP'] - BCP-47 language tag
   */
  init(options = {}) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[STT] SpeechRecognition API not available');
      return;
    }

    this._language = options.language || 'ja-JP';

    this._recognition = new SpeechRecognition();
    this._recognition.continuous = true;
    this._recognition.interimResults = true;
    this._recognition.lang = this._language;

    this._recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      if (finalText && this._onText) {
        this._onText(finalText, true);
      } else if (interimText && this._onText) {
        this._onText(interimText, false);
      }
    };

    this._recognition.onerror = (event) => {
      console.error('[STT] Error:', event.error);
      // Auto-restart on non-fatal errors
      if (event.error === 'no-speech' || event.error === 'aborted') {
        if (this._isRunning) this._restart();
      }
    };

    this._recognition.onend = () => {
      if (this._isRunning) this._restart();
    };

    console.log('[STT] Initialised with language:', this._language);
  }

  /**
   * Start speech recognition.
   */
  start() {
    if (!this._recognition) return;
    this._isRunning = true;
    try {
      this._recognition.start();
      console.log('[STT] Started');
    } catch {
      // Already running
    }
  }

  /**
   * Stop speech recognition.
   */
  stop() {
    this._isRunning = false;
    if (this._recognition) {
      try { this._recognition.stop(); } catch { /* ignore */ }
    }
  }

  /**
   * Register callback for transcribed text.
   * @param {function(string, boolean):void} callback - (text, isFinal)
   */
  onText(callback) {
    this._onText = callback;
  }

  /**
   * Change recognition language.
   * @param {string} lang - BCP-47 tag (e.g. 'en-US', 'ja-JP')
   */
  setLanguage(lang) {
    this._language = lang;
    if (this._recognition) {
      this._recognition.lang = lang;
      if (this._isRunning) {
        this.stop();
        this.start();
      }
    }
  }

  /** @private */
  _restart() {
    setTimeout(() => {
      if (this._isRunning && this._recognition) {
        try { this._recognition.start(); } catch { /* ignore */ }
      }
    }, 300);
  }
}

export default WhisperSTT;
