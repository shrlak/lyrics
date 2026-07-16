// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from '../utils/types';
import type { BatchRecognitionMode, ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionEngine } from './aiSettings';
import { recognizeBatchWithGemini, recognizeWithGemini } from './scoreAi';
import { recognizeBatchWithNvidia, recognizeWithNvidia } from './scoreNvidia';
import { recognizeBatchWithHuggingFace, recognizeWithHuggingFace } from './scoreHuggingFace';
import { isTransientRecognitionError } from './recognitionError';
import { sortSectionsByOrder } from '../utils/slidePlanner';

/**
 * Base URL of the optional shared recognition proxy (see worker/), baked into
 * the build at deploy time. Non-secret — safe to expose in client code, since
 * the actual API keys live only on the proxy server.
 */
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** Wait before the single transient-failure retry (rate limit bursts, 5xx). */
const TRANSIENT_RETRY_DELAY_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an engine call, retrying once after a short pause when the failure is
 * transient (429/408/5xx/network). One retry rescues rate-limit bursts and
 * hiccups without materially delaying the fallback to the next engine.
 */
async function withTransientRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isTransientRecognitionError(error)) throw error;
    await delay(TRANSIENT_RETRY_DELAY_MS);
    return call();
  }
}

/**
 * One recognition try: an engine, and for Gemini the specific model. The
 * lyric passes expand Gemini into its model ladder (Pro → Flash) so the
 * strongest available model answers before recognition leaves Gemini.
 */
interface EngineAttempt {
  engine: RecognitionEngine;
  geminiModel?: string;
}

function planAttempts(settings: AiSettings, lyricPass: boolean): EngineAttempt[] {
  const engines = [settings.engine, ...settings.fallbackEngines].filter((e) => e !== 'off');
  const attempts: EngineAttempt[] = [];
  for (const engine of engines) {
    if (engine === 'gemini') {
      const ladder =
        lyricPass && settings.geminiLyricsModels.length > 0
          ? settings.geminiLyricsModels
          : [settings.geminiModel];
      for (const geminiModel of ladder) attempts.push({ engine, geminiModel });
    } else {
      attempts.push({ engine });
    }
  }
  return attempts;
}

async function recognizeWithEngine(
  attempt: EngineAttempt,
  dataUrl: string,
  settings: AiSettings,
): Promise<ParsedScore> {
  if (attempt.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeWithGemini(
      dataUrl,
      key,
      attempt.geminiModel ?? settings.geminiModel,
      settings.geminiUseSearch,
      PROXY_URL,
    );
  }
  if (attempt.engine === 'nvidia') {
    const key = settings.nvidiaApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('NVIDIA API 키가 설정되지 않았습니다.');
    return recognizeWithNvidia(dataUrl, key, undefined, PROXY_URL);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeWithHuggingFace(dataUrl, key, undefined, PROXY_URL);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

export interface RecognitionResult {
  score: ParsedScore;
  /** Which engine actually produced the result, so the UI can say so. */
  engine: RecognitionEngine;
}

export interface BatchRecognitionResult {
  /** Results remain aligned with the input image order. */
  scores: ParsedScore[];
  engine: RecognitionEngine;
}

async function recognizeBatchWithEngine(
  attempt: EngineAttempt,
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<ParsedScore[]> {
  if (attempt.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeBatchWithGemini(
      dataUrls,
      key,
      attempt.geminiModel ?? settings.geminiModel,
      mode,
      mode === 'full' && settings.geminiUseSearch,
      PROXY_URL,
      hints,
    );
  }
  if (attempt.engine === 'nvidia') {
    const key = settings.nvidiaApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('NVIDIA API 키가 설정되지 않았습니다.');
    return recognizeBatchWithNvidia(dataUrls, key, mode, undefined, PROXY_URL, hints);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeBatchWithHuggingFace(dataUrls, key, mode, undefined, PROXY_URL, hints);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

/** True when the result carries nothing usable at all. */
function isEmptyScore(score: ParsedScore | undefined): boolean {
  if (!score) return true;
  return !score.title && !score.key && score.order.length === 0 && score.sections.length === 0;
}

/**
 * Recognize a set of score pages as one operation. Each engine uses one
 * multimodal request for the entire set. An engine answer where every page
 * came back completely empty counts as a failure — a well-formed but blank
 * response must fall through to the next engine, not silently produce blank
 * cards.
 */
export async function recognizeScoreBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  /** Optional per-image title hints (e.g. from the conti cover), advisory only. */
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) return { scores: [], engine: settings.engine };
  const attempts = planAttempts(settings, mode === 'full');
  if (attempts.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const scores = await withTransientRetry(() =>
        recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints),
      );
      if (scores.every((score) => isEmptyScore(score))) {
        throw new Error('인식 결과가 비어 있습니다.');
      }
      return { scores, engine: attempt.engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `${attempt.engine}${attempt.geminiModel ? ` (${attempt.geminiModel})` : ''} 일괄 인식 실패, 다음 시도:`,
        lastError.message,
      );
    }
  }
  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

/**
 * Run recognition on one score image in priority order — Gemini until its
 * tokens/quota run out or it otherwise fails, then the NVIDIA-hosted vision
 * model, then Hugging Face (per DEFAULT_AI_SETTINGS). An empty answer also
 * moves on to the next engine.
 */
export async function recognizeScore(dataUrl: string, settings: AiSettings): Promise<RecognitionResult> {
  const attempts = planAttempts(settings, true);
  if (attempts.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const score = await withTransientRetry(() => recognizeWithEngine(attempt, dataUrl, settings));
      if (isEmptyScore(score)) throw new Error('인식 결과가 비어 있습니다.');
      return { score, engine: attempt.engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `${attempt.engine}${attempt.geminiModel ? ` (${attempt.geminiModel})` : ''} 인식 실패, 다음 시도:`,
        lastError.message,
      );
    }
  }

  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

function hasLyrics(song: Song): boolean {
  return song.sections.some((s) => s.lines.some((l) => l.trim().length > 0));
}

/** A stub title like "새 찬양 (p.3)" that recognition may replace. */
function isStubTitle(title: string): boolean {
  return !title.trim() || /^새 찬양/.test(title.trim());
}

/**
 * Merge a recognition result onto a song. Recognized lyrics/sections replace the
 * blank scaffold, but a title/key/order the user already set is kept. Returns a
 * new Song (never mutates the input).
 */
export function applyScoreToSong(song: Song, parsed: ParsedScore): Song {
  const next: Song = { ...song };

  if (parsed.title && isStubTitle(song.title)) next.title = parsed.title;
  if (parsed.key && !song.key) next.key = parsed.key;

  // Only fill sections/order if the user hasn't started writing lyrics.
  if (!hasLyrics(song) && parsed.sections.length > 0) {
    const recognized = parsed.sections.map((s) => ({ label: s.label, lines: [...s.lines] }));
    const order =
      parsed.order.length > 0
        ? parsed.order
        : ['I', ...recognized.map((s) => s.label)]; // no printed order: derive one (title slide is "I")
    next.sections = sortSectionsByOrder(recognized, order);
    next.order = [...order];
  } else if (parsed.order.length > 0 && song.order.join('-') === 'I') {
    // Lyrics already present but order is still the default — accept the order.
    next.order = [...parsed.order];
  }

  return next;
}
