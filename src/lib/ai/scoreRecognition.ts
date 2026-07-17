// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from '../utils/types';
import type { BatchRecognitionMode, ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionAttempt, RecognitionEngine } from './aiSettings';
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
 * transient (408/5xx/network). One retry rescues brief provider hiccups while
 * the rest of the model pool continues independently.
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
 * Return the complete shared model pool. Every recognition phase launches
 * this entire pool concurrently; array order is display-only and never gates
 * which provider starts first.
 */
function planAttempts(settings: AiSettings): RecognitionAttempt[] {
  return settings.attempts;
}

async function recognizeWithEngine(
  attempt: RecognitionAttempt,
  dataUrl: string,
  settings: AiSettings,
): Promise<ParsedScore> {
  if (attempt.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeWithGemini(dataUrl, key, attempt.model, settings.geminiUseSearch, PROXY_URL);
  }
  if (attempt.engine === 'nvidia') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeWithNvidia(dataUrl, key, attempt.model, PROXY_URL);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeWithHuggingFace(dataUrl, key, attempt.model, PROXY_URL);
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
  attempt: RecognitionAttempt,
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
      attempt.model,
      mode,
      mode === 'full' && settings.geminiUseSearch,
      PROXY_URL,
      hints,
    );
  }
  if (attempt.engine === 'nvidia') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeBatchWithNvidia(dataUrls, key, mode, attempt.model, PROXY_URL, hints);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeBatchWithHuggingFace(dataUrls, key, mode, attempt.model, PROXY_URL, hints);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

/** True when the result carries nothing usable at all. */
function isEmptyScore(score: ParsedScore | undefined): boolean {
  if (!score) return true;
  // A confidently classified non-score page is useful even when it contains
  // neither requested field: the caller must still keep it out of 찬양 가사.
  if (score.pageType === 'non_score') return false;
  return (
    !score.sermonTitle &&
    !score.scripture &&
    !score.title &&
    !score.key &&
    score.order.length === 0 &&
    score.sections.length === 0
  );
}

/**
 * Recognize a set of score pages as one operation. Every model receives one
 * multimodal batch request at the same time; blank answers never claim a page.
 */
export async function recognizeScoreBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  /** Optional per-image title hints (e.g. from the conti cover), advisory only. */
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints);
}

/**
 * Run every configured model on one score image at the same time and return
 * the first non-empty result to finish.
 */
export async function recognizeScore(dataUrl: string, settings: AiSettings): Promise<RecognitionResult> {
  const attempts = planAttempts(settings);
  if (attempts.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  try {
    return await Promise.any(
      attempts.map(async (attempt) => {
        const score = await withTransientRetry(() => recognizeWithEngine(attempt, dataUrl, settings));
        if (isEmptyScore(score)) throw new Error('인식 결과가 비어 있습니다.');
        return { score, engine: attempt.engine };
      }),
    );
  } catch (error) {
    const causes = error instanceof AggregateError ? error.errors : [error];
    const first = causes[0];
    throw (first instanceof Error ? first : new Error(String(first || '모든 인식 엔진이 실패했습니다.')));
  }
}

/**
 * Start every model together. The first non-empty answer to finish claims
 * each page; later answers only fill pages that are still blank. This is a
 * completion race, not a configured priority ladder. It resolves as soon as
 * every page has a result, while the already-started provider calls finish in
 * the background and remain safely accounted for by the Worker.
 */
function recognizeBatchWithAllModels(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) {
    return Promise.resolve({ scores: [], engine: settings.attempts[0]?.engine ?? 'off' });
  }
  const attempts = planAttempts(settings);
  if (attempts.length === 0) return Promise.reject(new Error('자동 인식이 꺼져 있습니다.'));

  return new Promise((resolve, reject) => {
    const merged: (ParsedScore | undefined)[] = Array.from({ length: dataUrls.length });
    const contributions = new Map<RecognitionAttempt, number>();
    let pending = attempts.length;
    let finished = false;
    let lastError: Error | null = null;

    const finish = (allSettled: boolean) => {
      if (finished) return;
      const hasAny = merged.some((score) => score !== undefined);
      const hasEvery = merged.every((score) => score !== undefined);
      if (!hasEvery && !allSettled) return;
      if (!hasAny) {
        if (allSettled) {
          finished = true;
          reject(lastError || new Error('모든 인식 엔진이 실패했습니다.'));
        }
        return;
      }
      const primary = [...contributions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? attempts[0];
      finished = true;
      resolve({
        scores: merged.map((score) => score ?? { order: [], sections: [] }),
        engine: primary.engine,
      });
    };

    for (const attempt of attempts) {
      void withTransientRetry(() => recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints))
        .then((scores) => {
          let contributed = 0;
          for (let index = 0; index < dataUrls.length; index += 1) {
            const score = scores[index];
            if (merged[index] === undefined && !isEmptyScore(score)) {
              merged[index] = score;
              contributed += 1;
            }
          }
          if (contributed > 0) contributions.set(attempt, contributed);
          finish(false);
        })
        .catch((error) => {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`${attempt.engine} (${attempt.model}) 동시 일괄 인식 실패:`, lastError.message);
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0) finish(true);
        });
    }
  });
}

/**
 * Compatibility name used by the full-lyrics flow. All models now launch in
 * one concurrent pool; there are no priority groups.
 */
export async function recognizeScoreBatchEnsemble(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints);
}

/**
 * Compatibility name used by the rescue flow. All configured models start
 * together and the first non-empty result wins.
 */
export async function recognizeScoreRaced(
  dataUrl: string,
  settings: AiSettings,
): Promise<RecognitionResult> {
  return recognizeScore(dataUrl, settings);
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
