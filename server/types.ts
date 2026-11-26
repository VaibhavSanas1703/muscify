export type TabId = 'home' | 'explore' | 'radio' | 'library' | 'search';

export interface Track {
  id: string;
  videoId?: string;
  title: string;
  artist: string;
  album?: string;
  year?: string;
  durationSec: number;
  durationFormatted: string;
  thumbnail: string;
  source: 'youtube' | 'local' | 'catalog';
  localUrl?: string;
  viewCount?: string;
  mood?: string;
  accentColor?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  tracks: Track[];
  createdAt: number;
  coverUrl?: string;
  source?: 'custom' | 'imported';
}

export interface MoodCategory {
  id: string;
  label: string;
  subtitle: string;
  color: string;
  query: string;
  image: string;
}

export interface RadioStation {
  id: string;
  title: string;
  subtitle: string;
  seedQuery: string;
  gradient: string;
  tag: string;
}

export interface ListeningStats {
  totalSecondsListened: number;
  totalPlays: number;
  memberSince: string;
  trackPlayCounts: Record<string, { track: Track; count: number }>;
}

export interface LyricsResponse {
  found: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
  trackName?: string;
  artistName?: string;
}
