import type { Song, Section, SlidePlan } from './types';

const DEFAULT_LINES_PER_SLIDE = 4;

/**
 * Find the section matching an order token.
 * Exact (case-insensitive) match first, then V→V1 for digitless tokens,
 * then V2→V for suffixed tokens whose exact label is absent.
 */
export function findSection(sections: Section[], token: string): Section | undefined {
  const want = token.trim().toUpperCase();
  const byLabel = (label: string) =>
    sections.find((s) => s.label.trim().toUpperCase() === label);

  const exact = byLabel(want);
  if (exact) return exact;
  if (!/\d/.test(want)) return byLabel(want + '1');
  return byLabel(want.replace(/\d+$/, ''));
}

function usableLines(section: Section | undefined): string[] {
  if (!section) return [];
  return section.lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Order tokens (except "I") that resolve to no section with at least one non-empty line. */
export function unmatchedTokens(song: Song): string[] {
  const missing = new Set<string>();
  for (const token of song.order) {
    if (token === 'I') continue;
    if (usableLines(findSection(song.sections, token)).length === 0) {
      missing.add(token);
    }
  }
  return [...missing];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Plan the slides for one song: a leading title slide, then lyric slides per order token. */
export function planSlides(song: Song): SlidePlan[] {
  const linesPerSlide =
    song.linesPerSlide && song.linesPerSlide >= 1 ? song.linesPerSlide : DEFAULT_LINES_PER_SLIDE;
  const plans: SlidePlan[] = [{ kind: 'title', title: song.title }];

  // With no order given, show every section in listed order.
  const order = song.order.length > 0 ? song.order : song.sections.map((s) => s.label);

  let atStart = true;
  for (const token of order) {
    if (token === 'I') {
      // The intro is already the leading title slide; later interludes repeat it.
      if (!atStart) plans.push({ kind: 'title', title: song.title });
      continue;
    }
    atStart = false;
    const lines = usableLines(findSection(song.sections, token));
    if (lines.length === 0) continue;
    for (const group of chunk(lines, linesPerSlide)) {
      plans.push({ kind: 'lyrics', title: song.title, lines: group });
    }
  }
  return plans;
}

/** Plan the slides for the whole deck. */
export function planAllSlides(songs: Song[]): SlidePlan[] {
  return songs.flatMap(planSlides);
}
