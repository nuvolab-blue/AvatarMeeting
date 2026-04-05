/**
 * @fileoverview Keyword-based emotion analysis for Japanese and English text.
 * Outputs emotion category and MuseTalk-compatible expression parameters.
 */

/** @typedef {'joy'|'anger'|'sadness'|'surprise'|'fear'|'neutral'} EmotionType */

/**
 * Keyword lists per emotion (Japanese + English).
 * @type {Object<EmotionType, string[]>}
 */
const KEYWORDS = {
  joy: [
    '嬉しい', '楽しい', 'ありがとう', '素晴らしい', '最高', '好き', '笑',
    '感謝', 'うれしい', 'たのしい', 'よかった', 'いいね',
    'happy', 'great', 'wonderful', 'thanks', 'love', 'excellent',
    'awesome', 'fantastic', 'glad', 'pleased',
  ],
  anger: [
    '怒', 'ふざけ', 'なぜ', 'むかつ', '理解できない', 'おかしい',
    'ひどい', '許せない', 'いい加減',
    'angry', 'why', 'ridiculous', 'unacceptable', 'furious', 'annoyed',
  ],
  sadness: [
    '悲しい', '残念', 'つらい', '寂しい', 'ごめん', '申し訳',
    'かなしい', 'さびしい',
    'sad', 'sorry', 'unfortunate', 'miss', 'regret', 'disappointed',
  ],
  surprise: [
    'えっ', '本当に', 'まさか', '驚', '信じられない', 'すごい',
    'マジ', 'うそ', 'びっくり',
    'wow', 'really', 'incredible', 'amazing', 'surprised', 'unbelievable',
  ],
  fear: [
    '怖い', '不安', '心配', '危険', 'リスク', 'ヤバい',
    'こわい', 'やばい',
    'scared', 'worried', 'dangerous', 'risk', 'afraid', 'terrified',
  ],
};

/**
 * Emotion → MuseTalk expression parameters mapping.
 * @type {Object<EmotionType, object>}
 */
const EMOTION_PARAMS = {
  joy: {
    mouthCorner: 0.25,
    browRaise: 0.2,
    browFurrow: 0,
    eyeWiden: 0.1,
    eyeNarrow: 0.1,
    mouthOpen: 0.1,
  },
  anger: {
    mouthCorner: -0.2,
    browRaise: 0,
    browFurrow: 0.35,
    eyeWiden: 0.1,
    eyeNarrow: 0.15,
    mouthOpen: 0.05,
  },
  sadness: {
    mouthCorner: -0.2,
    browRaise: 0.15,
    browFurrow: 0.1,
    eyeWiden: 0,
    eyeNarrow: 0.1,
    mouthOpen: 0,
  },
  surprise: {
    mouthCorner: 0,
    browRaise: 0.45,
    browFurrow: 0,
    eyeWiden: 0.35,
    eyeNarrow: 0,
    mouthOpen: 0.25,
  },
  fear: {
    mouthCorner: -0.1,
    browRaise: 0.35,
    browFurrow: 0.15,
    eyeWiden: 0.3,
    eyeNarrow: 0,
    mouthOpen: 0.15,
  },
  neutral: {
    mouthCorner: 0,
    browRaise: 0,
    browFurrow: 0,
    eyeWiden: 0,
    eyeNarrow: 0,
    mouthOpen: 0,
  },
};

/** Emoji per emotion for UI display */
const EMOTION_EMOJI = {
  joy: '😊',
  anger: '😠',
  sadness: '😢',
  surprise: '😲',
  fear: '😰',
  neutral: '😐',
};

class EmotionAnalyzer {
  constructor() {
    /** @private */ this._prevEmotion = 'neutral';
  }

  /**
   * Analyse text and return emotion category, confidence, and expression params.
   * @param {string} text
   * @returns {{emotion: EmotionType, confidence: number, params: object, emoji: string}}
   */
  analyze(text) {
    if (!text || text.trim().length === 0) {
      return this._makeResult('neutral', 0);
    }

    const lower = text.toLowerCase();
    const scores = {};
    let maxScore = 0;
    let maxEmotion = 'neutral';

    for (const [emotion, keywords] of Object.entries(KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          score += 1;
        }
      }
      scores[emotion] = score;
      if (score > maxScore) {
        maxScore = score;
        maxEmotion = emotion;
      }
    }

    // Require at least one keyword match
    if (maxScore === 0) {
      return this._makeResult('neutral', 0);
    }

    // Confidence: normalise by total keyword matches
    const totalMatches = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = totalMatches > 0 ? maxScore / totalMatches : 0;

    this._prevEmotion = maxEmotion;
    return this._makeResult(maxEmotion, confidence);
  }

  /**
   * Build result object.
   * @private
   * @param {EmotionType} emotion
   * @param {number} confidence
   */
  _makeResult(emotion, confidence) {
    return {
      emotion,
      confidence: Math.round(confidence * 100) / 100,
      params: { ...EMOTION_PARAMS[emotion] },
      emoji: EMOTION_EMOJI[emotion],
    };
  }
}

export { EMOTION_EMOJI };
export default EmotionAnalyzer;
