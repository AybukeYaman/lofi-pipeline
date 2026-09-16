import type { MusicTrack } from '../types';
import { StatusBadge, type AssetStatus } from './StatusBadge';

export function TrackList({ tracks }: { tracks: MusicTrack[] }) {
  return (
    <ol className="track-list">
      {tracks.map((track) => (
        <li key={track.number}>
          <span className="track-number">{String(track.number).padStart(2, '0')}</span>
          <span className="track-title">{track.title}</span>
          {track.status ? (
            <StatusBadge status={trackStatus(track.status)} label={track.status.replace(/_/g, ' ')} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function trackStatus(status: string): AssetStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'waiting';
  return 'processing';
}
