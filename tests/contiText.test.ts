import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPages,
  deriveSongsFromMusicPages,
  matchSongsToPages,
  parseCoverText,
  splitLyricsAndConfessionSongs,
} from '../src/lib/contiText';
import type { LibraryEntry } from '../src/lib/types';

const coverText = readFileSync(join(__dirname, 'fixtures', 'cover.txt'), 'utf-8');
const notesText = readFileSync(join(__dirname, 'fixtures', 'notes.txt'), 'utf-8');

describe('parseCoverText', () => {
  const info = parseCoverText(coverText);

  it('parses the real example cover page', () => {
    expect(info).not.toBeNull();
    expect(info?.date).toBe('7/11/26');
    expect(info?.sermonTitle).toBe('하나님과 화평을 누리자');
    expect(info?.scripture).toBe('로마서 5장 1-11절');
  });

  it('extracts the song list with keys and descriptions', () => {
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['주님의 사랑', 'E'],
      ['주 은혜임을', 'F'],
      ['입례', 'F'],
    ]);
    for (const s of info?.songs ?? []) {
      expect(s.description?.length).toBeGreaterThan(3);
    }
  });

  it('returns null for non-cover text', () => {
    expect(parseCoverText('그냥 아무 내용 없는 페이지')).toBeNull();
    expect(parseCoverText(notesText)).toBeNull();
  });
});

describe('classifyPages', () => {
  it('identifies cover, notes, and music pages', () => {
    const { coverIndex, notesIndex, musicPages } = classifyPages([
      coverText,
      notesText,
      'junk music one',
      'junk music two',
    ]);
    expect(coverIndex).toBe(1);
    expect(notesIndex).toBe(2);
    expect(musicPages).toEqual([3, 4]);
  });
});

describe('matchSongsToPages', () => {
  it('matches by title text when present, else sequentially', () => {
    const info = parseCoverText(coverText)!;
    const pageTexts = [coverText, notesText, 'garbled', '주 은혜임을 KaMU', 'garbled 2'];
    matchSongsToPages(info, pageTexts, [3, 4, 5]);
    // 주 은혜임을 finds its page by text; the others fill remaining pages in order.
    expect(info.songs.find((s) => s.title === '주 은혜임을')?.pageIndex).toBe(4);
    expect(info.songs.find((s) => s.title === '주님의 사랑')?.pageIndex).toBe(3);
    expect(info.songs.find((s) => s.title === '입례')?.pageIndex).toBe(5);
  });
});

describe('deriveSongsFromMusicPages', () => {
  const library: LibraryEntry[] = [
    { title: '주 은혜임을', key: 'F', sections: [{ label: 'C', lines: ['가사'] }], order: ['C'] },
  ];

  it('builds one song per music page, in page order', () => {
    const pageTexts = ['garbled', '주 은혜임을 KaMU', 'garbled 2'];
    const songs = deriveSongsFromMusicPages(pageTexts, [1, 2, 3], library);
    expect(songs.map((s) => s.pageIndex)).toEqual([1, 2, 3]);
  });

  it('matches the library by page text and stubs the rest', () => {
    const pageTexts = ['garbled', '주 은혜임을 KaMU', 'garbled 2'];
    const songs = deriveSongsFromMusicPages(pageTexts, [1, 2, 3], library);
    expect(songs[1]).toMatchObject({ title: '주 은혜임을', key: 'F', pageIndex: 2 });
    expect(songs[0].title).toBe('새 찬양 (p.1)');
    expect(songs[2].title).toBe('새 찬양 (p.3)');
  });

  it('splits off the last derived song as the 공동체 고백송', () => {
    const songs = deriveSongsFromMusicPages(['a', 'b', 'c'], [1, 2, 3], library);
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(songs);
    expect(lyricsSongs.map((s) => s.pageIndex)).toEqual([1, 2]);
    expect(confessionSong?.pageIndex).toBe(3);
  });
});

describe('splitLyricsAndConfessionSongs', () => {
  it('excludes the final conti song from generated lyrics', () => {
    const info = parseCoverText(coverText)!;
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(info.songs);
    expect(lyricsSongs.map((song) => song.title)).toEqual(['주님의 사랑', '주 은혜임을']);
    expect(confessionSong?.title).toBe('입례');
  });

  it('handles an empty conti', () => {
    expect(splitLyricsAndConfessionSongs([])).toEqual({ lyricsSongs: [] });
  });
});
