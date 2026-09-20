import { useState } from 'react';
import type { MusicTrack } from '../types';
import { StatusBadge, type AssetStatus } from './StatusBadge';

export function TrackList({ tracks }: { tracks: MusicTrack[] }) {
  const [copiedTrackNum, setCopiedTrackNum] = useState<number | null>(null);

  const handleCopyPrompt = async (track: MusicTrack) => {
    const textToCopy = track.prompt || `${track.title} - Lofi ambient instrumental`;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedTrackNum(track.number);
      setTimeout(() => setCopiedTrackNum(null), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <ol className="track-list" style={{ listStyle: 'none', padding: 0, margin: '10px 0' }}>
      {tracks.map((track) => {
        const isCopied = copiedTrackNum === track.number;
        return (
          <li
            key={track.number}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              marginBottom: 4,
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
              <span
                className="track-number"
                style={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--text-muted)',
                  background: 'var(--bg-surface-subtle)',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                {String(track.number).padStart(2, '0')}
              </span>
              <div style={{ minWidth: 0 }}>
                <span className="track-title" style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {track.title}
                </span>
                {track.file ? (
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 8 }}>
                    📁 {track.file}
                  </span>
                ) : null}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {track.prompt ? (
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: 11, minHeight: 24, padding: '1px 8px' }}
                  title="Suno Promptunu Kopyala"
                  onClick={() => handleCopyPrompt(track)}
                >
                  {isCopied ? '✓ Copied' : '📋 Copy Prompt'}
                </button>
              ) : null}
              {track.status ? (
                <StatusBadge status={trackStatus(track.status)} label={track.status.replace(/_/g, ' ')} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function trackStatus(status: string): AssetStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'waiting';
  return 'processing';
}

