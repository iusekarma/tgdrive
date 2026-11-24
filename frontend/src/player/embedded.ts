import type { Cue } from "./subtitles";

export interface EmbeddedTrack {
  id: string;
  language: string;
  name: string;
  isDefault: boolean;
  forced: boolean;
  /** Set if it can't be shown: what it is instead (usually pictures of text). */
  format: string | null;
  /** Those found so far; more are added as playback goes on. */
  cues: Cue[];
}

export interface EmbeddedSubtitles {
  tracks: EmbeddedTrack[];
  collect(from: number, to: number): Promise<void>;
}
