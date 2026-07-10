import { describe, expect, it } from 'vitest';
import { findSection, planSlides, planAllSlides, unmatchedTokens } from '../src/lib/slidePlanner';
import type { Song } from '../src/lib/types';

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

function song(partial: Partial<Song>): Song {
  return {
    id: 't',
    title: '테스트 찬양',
    sections: [],
    order: [],
    linesPerSlide: 4,
    ...partial,
  };
}

describe('findSection', () => {
  const sections = [
    { label: 'V1', lines: ['a'] },
    { label: 'PC', lines: ['b'] },
    { label: 'C', lines: ['c'] },
  ];

  it('matches exactly, case-insensitively', () => {
    expect(findSection(sections, 'pc')?.label).toBe('PC');
  });

  it('falls back V → V1', () => {
    expect(findSection(sections, 'V')?.label).toBe('V1');
  });

  it('falls back C2 → C', () => {
    expect(findSection(sections, 'C2')?.label).toBe('C');
  });

  it('returns undefined for unknown tokens', () => {
    expect(findSection(sections, 'B')).toBeUndefined();
  });
});

describe('planSlides', () => {
  it('always leads with a title slide and dedupes the leading I', () => {
    const s = song({
      sections: [{ label: 'V1', lines: lines(2) }],
      order: ['I', 'V1'],
    });
    const plans = planSlides(s);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual({ kind: 'title', title: '테스트 찬양' });
    expect(plans[1].kind).toBe('lyrics');
  });

  it('renders a mid-order I as another title slide', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(2) }],
      order: ['I', 'C', 'I', 'C'],
    });
    const kinds = planSlides(s).map((p) => p.kind);
    expect(kinds).toEqual(['title', 'lyrics', 'title', 'lyrics']);
  });

  it('chunks a 10-line section into 4/4/2', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(10) }],
      order: ['C'],
    });
    const plans = planSlides(s);
    expect(plans.map((p) => p.lines?.length ?? 0)).toEqual([0, 4, 4, 2]);
  });

  it('respects linesPerSlide and skips blank lines', () => {
    const s = song({
      sections: [{ label: 'V1', lines: ['a', ' ', 'b', '', 'c'] }],
      order: ['V1'],
      linesPerSlide: 2,
    });
    const plans = planSlides(s);
    expect(plans[1].lines).toEqual(['a', 'b']);
    expect(plans[2].lines).toEqual(['c']);
  });

  it('skips unknown tokens instead of failing', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(1) }],
      order: ['C', '기도'],
    });
    expect(planSlides(s)).toHaveLength(2);
  });

  it('repeats sections for repeated tokens', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(4) }],
      order: ['C', 'C'],
    });
    expect(planSlides(s).filter((p) => p.kind === 'lyrics')).toHaveLength(2);
  });

  it('falls back to all sections when order is empty', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: lines(2) },
        { label: 'C', lines: lines(2) },
      ],
      order: [],
    });
    expect(planSlides(s)).toHaveLength(3);
  });
});

describe('unmatchedTokens', () => {
  it('reports tokens without lyrics, ignoring I', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: lines(2) },
        { label: 'B', lines: [' '] },
      ],
      order: ['I', 'V1', 'B', '기도', 'B'],
    });
    expect(unmatchedTokens(s).sort()).toEqual(['B', '기도']);
  });
});

describe('planAllSlides', () => {
  it('concatenates songs in order', () => {
    const a = song({ title: 'A', sections: [{ label: 'C', lines: lines(2) }], order: ['C'] });
    const b = song({ title: 'B', sections: [{ label: 'C', lines: lines(2) }], order: ['C'] });
    const plans = planAllSlides([a, b]);
    expect(plans).toHaveLength(4);
    expect(plans[0].title).toBe('A');
    expect(plans[2].title).toBe('B');
  });
});
