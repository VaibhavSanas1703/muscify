import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { CURATED_TRACKS, MOOD_CATEGORIES, RADIO_STATIONS } from './server/catalog.ts';
import type { Track } from './server/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;

function getYouTubeKey(): string | null {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key || key === 'MY_YOUTUBE_API_KEY') {
    return null;
  }
  return key;
}

function sanitizeQuery(raw: unknown, maxLen = 120): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseIsoDuration(iso: string | undefined): { seconds: number; formatted: string } {
  if (!iso) return { seconds: 210, formatted: '3:30' };
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return { seconds: 210, formatted: '3:30' };
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (total <= 0) return { seconds: 0, formatted: 'Live' };
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const formatted =
    hours > 0
      ? `${hours}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${mm}:${String(ss).padStart(2, '0')}`;
  return { seconds: total, formatted };
}

function cleanVideoMeta(rawTitle: string, channelTitle: string): { title: string; artist: string } {
  const decodedTitle = decodeHtmlEntities(rawTitle);
  const cleanedChannel = decodeHtmlEntities(channelTitle)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  // If title uses "Artist - Song", split cleanly when channel is generic
  const dashSplit = decodedTitle.split(' - ');
  if (dashSplit.length >= 2 && dashSplit[0].length < 40 && dashSplit[1].length > 1) {
    const cleanSong = dashSplit
      .slice(1)
      .join(' - ')
      .replace(/\(Official.*?\)|\[Official.*?\]/gi, '')
      .trim();
    return {
      title: cleanSong || decodedTitle,
      artist: dashSplit[0].trim() || cleanedChannel,
    };
  }

  return {
    title: decodedTitle.replace(/\(Official\s*(Music\s*)?Video\)|\[Official.*?\]/gi, '').trim() || decodedTitle,
    artist: cleanedChannel || 'Unknown Artist',
  };
}

interface YouTubeSearchItem {
  id: { videoId?: string } | string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: {
      maxres?: { url: string };
      high?: { url: string };
      medium?: { url: string };
      default?: { url: string };
    };
  };
}

interface YouTubeVideoDetail {
  id: string;
  snippet?: YouTubeSearchItem['snippet'];
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

function formatViews(viewCount?: string): string | undefined {
  if (!viewCount) return undefined;
  const num = Number(viewCount);
  if (!Number.isFinite(num)) return undefined;
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B plays`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M plays`;
  if (num >= 1_000) return `${Math.round(num / 1_000)}K plays`;
  return `${num} plays`;
}

async function fetchYouTubeTracksBySearch(
  query: string,
  maxResults = 16,
  apiKey: string,
): Promise<Track[]> {
  const searchUrl = new URL(`${YOUTUBE_API_BASE}/search`);
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('videoCategoryId', '10');
  searchUrl.searchParams.set('videoEmbeddable', 'true');
  searchUrl.searchParams.set('maxResults', String(Math.min(25, Math.max(1, maxResults))));
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('key', apiKey);

  const searchRes = await fetch(searchUrl.toString(), { signal: AbortSignal.timeout(7000) });
  if (!searchRes.ok) {
    let reason = `HTTP ${searchRes.status}`;
    try {
      const errJson = (await searchRes.json()) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      const apiReason = errJson.error?.errors?.[0]?.reason;
      const apiMsg = errJson.error?.message;
      reason = apiReason ? `${apiReason}: ${apiMsg || ''}` : apiMsg || reason;
    } catch {
      // Ignore parse failure
    }
    throw new Error(reason.slice(0, 180));
  }

  const searchJson = (await searchRes.json()) as { items?: YouTubeSearchItem[] };
  const items = searchJson.items || [];
  const videoIds = items
    .map((item) => (typeof item.id === 'string' ? item.id : item.id?.videoId))
    .filter((id): id is string => Boolean(id && VIDEO_ID_RE.test(id)));

  if (videoIds.length === 0) return [];

  const detailsUrl = new URL(`${YOUTUBE_API_BASE}/videos`);
  detailsUrl.searchParams.set('part', 'snippet,contentDetails,statistics');
  detailsUrl.searchParams.set('id', videoIds.join(','));
  detailsUrl.searchParams.set('key', apiKey);

  const detailsRes = await fetch(detailsUrl.toString(), { signal: AbortSignal.timeout(7000) });
  if (!detailsRes.ok) {
    // Fallback to search snippet if details quota fails
    return items
      .map((item): Track | null => {
        const videoId = typeof item.id === 'string' ? item.id : item.id?.videoId;
        if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
        const meta = cleanVideoMeta(item.snippet?.title || 'Untitled', item.snippet?.channelTitle || 'Muscify Stream');
        const thumb =
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        return {
          id: videoId,
          videoId,
          title: meta.title,
          artist: meta.artist,
          year: item.snippet?.publishedAt?.slice(0, 4),
          durationSec: 210,
          durationFormatted: '3:30',
          thumbnail: thumb,
          source: 'youtube',
        };
      })
      .filter((t): t is Track => t !== null);
  }

  const detailsJson = (await detailsRes.json()) as { items?: YouTubeVideoDetail[] };
  const detailMap = new Map<string, YouTubeVideoDetail>();
  for (const d of detailsJson.items || []) {
    detailMap.set(d.id, d);
  }

  return videoIds.map((videoId) => {
    const detail = detailMap.get(videoId);
    const snippet = detail?.snippet;
    const meta = cleanVideoMeta(snippet?.title || 'Untitled', snippet?.channelTitle || 'Muscify Stream');
    const duration = parseIsoDuration(detail?.contentDetails?.duration);
    const thumb =
      snippet?.thumbnails?.maxres?.url ||
      snippet?.thumbnails?.high?.url ||
      snippet?.thumbnails?.medium?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    return {
      id: videoId,
      videoId,
      title: meta.title,
      artist: meta.artist,
      year: snippet?.publishedAt?.slice(0, 4),
      durationSec: duration.seconds,
      durationFormatted: duration.formatted,
      thumbnail: thumb,
      source: 'youtube',
      viewCount: formatViews(detail?.statistics?.viewCount),
    };
  });
}

async function fetchYouTubeTrendingMusic(regionCode: string, apiKey: string): Promise<Track[]> {
  const url = new URL(`${YOUTUBE_API_BASE}/videos`);
  url.searchParams.set('part', 'snippet,contentDetails,statistics');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('maxResults', '18');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(7000) });
  if (!res.ok) {
    throw new Error(`YouTube trending failed (${res.status})`);
  }
  const json = (await res.json()) as { items?: YouTubeVideoDetail[] };
  return (json.items || [])
    .filter((item) => VIDEO_ID_RE.test(item.id))
    .map((item) => {
      const meta = cleanVideoMeta(item.snippet?.title || 'Untitled', item.snippet?.channelTitle || 'Muscify Stream');
      const duration = parseIsoDuration(item.contentDetails?.duration);
      const thumb =
        item.snippet?.thumbnails?.maxres?.url ||
        item.snippet?.thumbnails?.high?.url ||
        `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;

      return {
        id: item.id,
        videoId: item.id,
        title: meta.title,
        artist: meta.artist,
        year: item.snippet?.publishedAt?.slice(0, 4),
        durationSec: duration.seconds,
        durationFormatted: duration.formatted,
        thumbnail: thumb,
        source: 'youtube',
        viewCount: formatViews(item.statistics?.viewCount),
      };
    });
}

function searchCatalogFallback(query: string): Track[] {
  const q = query.toLowerCase();
  if (!q) return CURATED_TRACKS;
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = CURATED_TRACKS.map((track) => {
    const haystack = `${track.title} ${track.artist} ${track.album || ''} ${track.mood || ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 1;
    }
    return { track, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.track);

  return scored.length > 0 ? scored : CURATED_TRACKS.slice(0, 10);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'muscify', youtubeConfigured: Boolean(getYouTubeKey()) });
  });

  app.get('/api/youtube/status', (_req, res) => {
    res.json({
      youtubeConfigured: Boolean(getYouTubeKey()),
    });
  });

  app.get('/api/youtube/home', async (req, res) => {
    const region = sanitizeQuery(req.query.regionCode, 4).toUpperCase() || 'IN';
    const safeRegion = /^[A-Z]{2}$/.test(region) ? region : 'IN';
    const apiKey = getYouTubeKey();

    if (apiKey) {
      try {
        const trending = await fetchYouTubeTrendingMusic(safeRegion, apiKey);
        if (trending.length >= 6) {
          return res.json({
            source: 'youtube',
            topPicks: trending.slice(0, 8),
            albumsAndSingles: trending.slice(8, 18),
            quickPicks: [...trending.slice(0, 4), ...CURATED_TRACKS.slice(0, 6)],
          });
        }
      } catch (err) {
        console.warn('YouTube home fallback triggered:', err instanceof Error ? err.message : err);
      }
    }

    return res.json({
      source: 'catalog',
      topPicks: CURATED_TRACKS.slice(0, 8),
      albumsAndSingles: CURATED_TRACKS.slice(8, 16),
      quickPicks: CURATED_TRACKS.slice(4, 14),
    });
  });

  app.get('/api/youtube/search', async (req, res) => {
    const q = sanitizeQuery(req.query.q, 120);
    if (!q) {
      return res.status(400).json({ error: 'Search query is required', tracks: [] });
    }
    const maxResults = Math.min(25, Math.max(5, Number(req.query.maxResults) || 18));
    const apiKey = getYouTubeKey();

    let fallbackReason: string | null = null;
    if (apiKey) {
      try {
        const tracks = await fetchYouTubeTracksBySearch(q, maxResults, apiKey);
        return res.json({
          source: 'youtube',
          tracks,
        });
      } catch (err) {
        fallbackReason = err instanceof Error ? err.message : 'YouTube API request failed';
        console.warn('YouTube search fallback triggered:', fallbackReason);
      }
    }

    const fallback = searchCatalogFallback(q);
    return res.json({
      source: 'catalog',
      tracks: fallback,
      notice: apiKey
        ? 'Showing curated catalog matches while live stream search refreshes.'
        : 'Showing curated catalog matches.',
    });
  });

  app.get('/api/youtube/mood', async (req, res) => {
    const moodId = sanitizeQuery(req.query.mood, 40).toLowerCase();
    const moodObj = MOOD_CATEGORIES.find((m) => m.id === moodId || m.label.toLowerCase() === moodId);
    const query = moodObj ? moodObj.query : `${moodId || 'chill'} music hits`;
    const apiKey = getYouTubeKey();

    if (apiKey) {
      try {
        const tracks = await fetchYouTubeTracksBySearch(query, 16, apiKey);
        return res.json({
          source: 'youtube',
          mood: moodObj || { id: moodId, label: moodId, subtitle: 'Curated Station' },
          tracks,
        });
      } catch (err) {
        console.warn('YouTube mood fallback:', err instanceof Error ? err.message : err);
      }
    }

    const moodFiltered = CURATED_TRACKS.filter((t) => t.mood === moodId);
    const tracks = moodFiltered.length >= 4 ? moodFiltered : [...moodFiltered, ...CURATED_TRACKS].slice(0, 10);
    return res.json({
      source: 'catalog',
      mood: moodObj || { id: moodId, label: moodId, subtitle: 'Curated Station' },
      tracks,
    });
  });

  app.get('/api/youtube/related', async (req, res) => {
    const videoId = sanitizeQuery(req.query.videoId, 20);
    const seedQuery = sanitizeQuery(req.query.q, 120) || 'trending music hits';
    const apiKey = getYouTubeKey();

    if (apiKey) {
      try {
        const raw = await fetchYouTubeTracksBySearch(seedQuery, 15, apiKey);
        const filtered = VIDEO_ID_RE.test(videoId) ? raw.filter((t) => t.videoId !== videoId) : raw;
        return res.json({ source: 'youtube', tracks: filtered });
      } catch (err) {
        console.warn('YouTube related fallback:', err instanceof Error ? err.message : err);
      }
    }

    const filtered = CURATED_TRACKS.filter((t) => t.videoId !== videoId);
    return res.json({ source: 'catalog', tracks: filtered.slice(0, 12) });
  });

  app.get('/api/catalog/meta', (_req, res) => {
    res.json({
      moods: MOOD_CATEGORIES,
      stations: RADIO_STATIONS,
    });
  });

  app.post('/api/youtube/import', async (req, res) => {
    const rawInput = sanitizeQuery(req.body?.input, 1000);
    if (!rawInput) {
      return res.status(400).json({ error: 'Please provide a playlist link or track list.' });
    }

    const apiKey = getYouTubeKey();

    // 1. Check if it's a YouTube Playlist URL
    try {
      if (rawInput.startsWith('http://') || rawInput.startsWith('https://')) {
        const parsed = new URL(rawInput);
        const allowedHosts = ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be', 'open.spotify.com'];
        if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
          return res.status(400).json({ error: 'Please enter a valid playlist link or a list of song titles.' });
        }

        const listId = parsed.searchParams.get('list');
        if (listId && PLAYLIST_ID_RE.test(listId) && apiKey) {
          const plUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
          plUrl.searchParams.set('part', 'snippet,contentDetails');
          plUrl.searchParams.set('maxResults', '25');
          plUrl.searchParams.set('playlistId', listId);
          plUrl.searchParams.set('key', apiKey);

          const plRes = await fetch(plUrl.toString(), { signal: AbortSignal.timeout(7000) });
          if (plRes.ok) {
            const plJson = (await plRes.json()) as {
              items?: Array<{
                snippet?: {
                  title?: string;
                  videoOwnerChannelTitle?: string;
                  channelTitle?: string;
                  resourceId?: { videoId?: string };
                  thumbnails?: { high?: { url: string }; medium?: { url: string } };
                };
              }>;
            };

            const importedTracks: Track[] = (plJson.items || [])
              .map((item): Track | null => {
                const vid = item.snippet?.resourceId?.videoId;
                if (!vid || !VIDEO_ID_RE.test(vid)) return null;
                const meta = cleanVideoMeta(
                  item.snippet?.title || 'Imported Track',
                  item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle || 'Muscify Stream',
                );
                return {
                  id: vid,
                  videoId: vid,
                  title: meta.title,
                  artist: meta.artist,
                  durationSec: 210,
                  durationFormatted: '3:30',
                  thumbnail:
                    item.snippet?.thumbnails?.high?.url ||
                    item.snippet?.thumbnails?.medium?.url ||
                    `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                  source: 'youtube',
                };
              })
              .filter((t): t is Track => t !== null);

            if (importedTracks.length > 0) {
              return res.json({
                playlistName: 'Imported Playlist',
                tracks: importedTracks,
                source: 'youtube',
              });
            }
          }
        }

        // Spotify playlist URL -> query oEmbed on fixed official host to get playlist title
        if (parsed.hostname.toLowerCase() === 'open.spotify.com') {
          const oembedUrl = new URL('https://open.spotify.com/oembed');
          oembedUrl.searchParams.set('url', parsed.toString());
          let title = 'Imported Spotify Mix';
          try {
            const oRes = await fetch(oembedUrl.toString(), { signal: AbortSignal.timeout(5000) });
            if (oRes.ok) {
              const oJson = (await oRes.json()) as { title?: string };
              if (oJson.title) title = sanitizeQuery(oJson.title, 80);
            }
          } catch {
            // Keep default title
          }

          if (apiKey) {
            const tracks = await fetchYouTubeTracksBySearch(`${title} official audio`, 12, apiKey);
            return res.json({ playlistName: title, tracks, source: 'youtube' });
          }
          return res.json({
            playlistName: title,
            tracks: searchCatalogFallback(title).slice(0, 8),
            source: 'catalog',
          });
        }
      }
    } catch {
      // Fall through to text-line parsing
    }

    // 2. Line-by-line song title import (e.g. pasted song names)
    const lines = rawInput
      .split(/\r?\n|,/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 2)
      .slice(0, 12);

    if (lines.length === 0) {
      return res.status(400).json({ error: 'No valid songs or playlist link found.' });
    }

    const collected: Track[] = [];
    for (const line of lines) {
      if (apiKey) {
        try {
          const matches = await fetchYouTubeTracksBySearch(line, 1, apiKey);
          if (matches[0]) collected.push(matches[0]);
          continue;
        } catch {
          // Fall back to catalog match
        }
      }
      const cat = searchCatalogFallback(line);
      if (cat[0] && !collected.some((c) => c.id === cat[0].id)) {
        collected.push(cat[0]);
      }
    }

    return res.json({
      playlistName: 'Imported Playlist',
      tracks: collected.length > 0 ? collected : CURATED_TRACKS.slice(0, 6),
      source: apiKey ? 'youtube' : 'catalog',
    });
  });

  function normalizeTextForMatch(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripSongNoise(rawTitle: string): string {
    return rawTitle
      .replace(/\|.*$/g, '')
      .replace(/\((?:from|official|lyric|lyrical|audio|video|full|hd|4k|feat\.?|ft\.?).*?\)/gi, '')
      .replace(/\[(?:official|lyric|lyrical|audio|video|full|hd|4k).*?\]/gi, '')
      .replace(/\b(?:official\s+(?:music\s+)?video|lyric\s+video|full\s+(?:song|audio|video)|lyrical|4k\s+video)\b/gi, '')
      .replace(/\s+(?:ft\.?|feat\.?)\s+.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  interface LrclibRecord {
    id?: number;
    trackName?: string;
    artistName?: string;
    duration?: number;
    instrumental?: boolean;
    plainLyrics?: string;
    syncedLyrics?: string;
  }

  function scoreLyricCandidate(
    candidate: LrclibRecord,
    targetTitleNorm: string,
    artistListNorm: string[],
    reqDuration: number,
  ): number {
    if (!candidate.plainLyrics && !candidate.syncedLyrics) return -1000;
    const candTitle = normalizeTextForMatch(stripSongNoise(candidate.trackName || ''));
    const candArtist = normalizeTextForMatch(candidate.artistName || '');
    if (!candTitle) return -1000;

    let score = 0;

    // Title match (mandatory relevance)
    if (candTitle === targetTitleNorm) {
      score += 60;
    } else if (candTitle.includes(targetTitleNorm) || targetTitleNorm.includes(candTitle)) {
      score += 32;
    } else {
      const targetWords = targetTitleNorm.split(' ').filter((w) => w.length > 1);
      const overlap = targetWords.filter((w) => candTitle.includes(w)).length;
      if (targetWords.length === 0 || overlap / targetWords.length < 0.6) {
        return -1000;
      }
      score += Math.round((overlap / targetWords.length) * 25);
    }

    // Artist match
    if (artistListNorm.length > 0 && candArtist) {
      const matchedArtist = artistListNorm.some(
        (a) => a.length > 1 && (candArtist.includes(a) || a.includes(candArtist)),
      );
      if (matchedArtist) {
        score += 45;
      } else {
        // Check word overlap on artist names
        const allArtistWords = artistListNorm.join(' ').split(' ').filter((w) => w.length > 2);
        const artistOverlap = allArtistWords.some((w) => candArtist.includes(w));
        score += artistOverlap ? 18 : -40;
      }
    }

    // Prefer synced lyrics
    if (candidate.syncedLyrics) score += 20;

    // Duration proximity (helps pick studio audio vs remix/slowed/live)
    if (reqDuration > 20 && candidate.duration && candidate.duration > 20) {
      const diff = Math.abs(candidate.duration - reqDuration);
      if (diff <= 4) score += 30;
      else if (diff <= 12) score += 16;
      else if (diff <= 25) score += 4;
      else if (diff > 45) score -= 25;
    }

    return score;
  }

  app.get('/api/lyrics', async (req, res) => {
    const rawTitle = sanitizeQuery(req.query.title, 160);
    const rawArtist = sanitizeQuery(req.query.artist, 160);
    const reqDuration = Math.max(0, Math.min(3600, Number(req.query.duration) || 0));

    if (!rawTitle) {
      return res.json({ found: false });
    }

    const cleanTitle = stripSongNoise(rawTitle) || rawTitle;
    const artistTokens = rawArtist
      .split(/,|&|\bx\b|\bfeat\.?\b|\bft\.?\b/i)
      .map((s) => s.trim())
      .filter(Boolean);
    const primaryArtist = artistTokens[0] || '';
    const targetTitleNorm = normalizeTextForMatch(cleanTitle);
    const artistListNorm = artistTokens.map(normalizeTextForMatch).filter(Boolean);

    try {
      // 1. Exact lookup with duration when available
      if (primaryArtist) {
        const getUrl = new URL('https://lrclib.net/api/get');
        getUrl.searchParams.set('track_name', cleanTitle);
        getUrl.searchParams.set('artist_name', primaryArtist);
        if (reqDuration > 20) {
          getUrl.searchParams.set('duration', String(Math.round(reqDuration)));
        }

        const getRes = await fetch(getUrl.toString(), {
          headers: { 'User-Agent': 'Muscify/1.0' },
          signal: AbortSignal.timeout(4500),
        });

        if (getRes.ok) {
          const exact = (await getRes.json()) as LrclibRecord;
          const exactScore = scoreLyricCandidate(exact, targetTitleNorm, artistListNorm, reqDuration);
          if (exactScore >= 40 && (exact.plainLyrics || exact.syncedLyrics)) {
            return res.json({
              found: true,
              plainLyrics: exact.plainLyrics,
              syncedLyrics: exact.syncedLyrics,
              trackName: exact.trackName,
              artistName: exact.artistName,
            });
          }
        }
      }

      // 2. Structured search (track_name + artist_name), then broader q search
      const candidates: LrclibRecord[] = [];

      const structuredUrl = new URL('https://lrclib.net/api/search');
      structuredUrl.searchParams.set('track_name', cleanTitle);
      if (primaryArtist) structuredUrl.searchParams.set('artist_name', primaryArtist);

      const structuredRes = await fetch(structuredUrl.toString(), {
        headers: { 'User-Agent': 'Muscify/1.0' },
        signal: AbortSignal.timeout(4500),
      });
      if (structuredRes.ok) {
        const items = (await structuredRes.json()) as LrclibRecord[];
        candidates.push(...items);
      }

      if (candidates.length === 0) {
        const broadUrl = new URL('https://lrclib.net/api/search');
        broadUrl.searchParams.set('q', `${cleanTitle} ${primaryArtist}`.trim());
        const broadRes = await fetch(broadUrl.toString(), {
          headers: { 'User-Agent': 'Muscify/1.0' },
          signal: AbortSignal.timeout(4500),
        });
        if (broadRes.ok) {
          const items = (await broadRes.json()) as LrclibRecord[];
          candidates.push(...items);
        }
      }

      const ranked = candidates
        .map((c) => ({
          c,
          score: scoreLyricCandidate(c, targetTitleNorm, artistListNorm, reqDuration),
        }))
        .filter((entry) => entry.score >= 35)
        .sort((a, b) => b.score - a.score);

      const best = ranked[0]?.c;
      if (best) {
        return res.json({
          found: true,
          plainLyrics: best.plainLyrics,
          syncedLyrics: best.syncedLyrics,
          trackName: best.trackName,
          artistName: best.artistName,
        });
      }
    } catch {
      // Graceful fallback
    }

    return res.json({ found: false });
  });

  // Download full app source code as a ZIP archive
  app.get('/api/download-code', async (_req, res) => {
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('muscify');
      if (!rootFolder) {
        return res.status(500).json({ error: 'Failed to initialize zip archive.' });
      }

      const excludedDirs = new Set([
        'node_modules',
        'dist',
        '.git',
        '.aistudio',
        '.vite',
      ]);

      const addDirectoryToZip = (dirPath: string, relBase: string) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            if (excludedDirs.has(entry.name)) continue;
            if (relPath === 'public/assets/aistudio') continue;
            addDirectoryToZip(fullPath, relPath);
          } else if (entry.isFile()) {
            // Never expose real secret .env files or existing zip archives
            if (/^\.env(\..+)?$/i.test(entry.name) && entry.name !== '.env.example') continue;
            if (entry.name.endsWith('.zip') || entry.name === 'bun.lock') continue;
            const fileBuffer = fs.readFileSync(fullPath);
            rootFolder.file(relPath, fileBuffer);
          }
        }
      };

      addDirectoryToZip(__dirname, '');

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="muscify-source-code.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      return res.send(zipBuffer);
    } catch (err) {
      console.error('Source code zip export failed:', err);
      return res.status(500).json({ error: 'Failed to generate source code zip.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Muscify server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Muscify server:', err);
  process.exit(1);
});
