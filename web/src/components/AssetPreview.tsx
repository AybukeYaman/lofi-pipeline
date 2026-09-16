import { useEffect, useState } from 'react';

type AssetPreviewProps = {
  kind: 'image' | 'video';
  fileName?: string | null;
  src?: string | null;
  emptyLabel: string;
  alt?: string;
};

export function AssetPreview({ kind, fileName, src, emptyLabel, alt }: AssetPreviewProps) {
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');

  useEffect(() => {
    if (src && fileName) {
      setLoadState('loading');
    } else {
      setLoadState('idle');
    }
  }, [src, fileName]);

  const hasFile = Boolean(fileName);
  const isLoaded = loadState === 'loaded';
  const isError = loadState === 'error';

  return (
    <figure className={hasFile ? 'asset-preview has-file' : 'asset-preview'}>
      <div className="asset-preview-frame">
        {hasFile && src && !isError ? (
          kind === 'image' ? (
            <img
              className="asset-preview-media"
              src={src}
              alt={alt ?? fileName ?? 'Preview'}
              onLoad={() => setLoadState('loaded')}
              onError={() => setLoadState('error')}
              style={{ display: isLoaded ? 'block' : 'none' }}
            />
          ) : (
            <video
              className="asset-preview-media"
              src={src}
              controls
              playsInline
              preload="metadata"
              onLoadedData={() => setLoadState('loaded')}
              onError={() => setLoadState('error')}
            />
          )
        ) : null}

        {loadState === 'loading' && kind === 'image' ? (
          <span className="muted" style={{ fontSize: 12 }}>Loading preview...</span>
        ) : null}

        {(!src || isError || !hasFile) ? (
          <span>{kind === 'image' ? 'IMAGE' : 'VIDEO'}</span>
        ) : null}
      </div>

      <figcaption>
        {fileName ? (
          <>
            <strong>{fileName}</strong>
            {isError ? (
              <span className="field-hint field-error">Preview file not accessible</span>
            ) : isLoaded ? (
              <span style={{ color: '#34603f' }}>Preview loaded</span>
            ) : (
              <span>Media asset</span>
            )}
          </>
        ) : (
          <span>{emptyLabel}</span>
        )}
      </figcaption>
    </figure>
  );
}

