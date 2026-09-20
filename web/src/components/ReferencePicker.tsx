import { useId, useRef, type ChangeEvent } from 'react';

/** `data` = base64 data URL (yeni yükleme). `url` = sunucudaki görsel URL'i (mevcut referans). */
export type ReferenceDraft = { id: string; name: string; data?: string; url?: string };

type ReferencePickerProps = {
  items: ReferenceDraft[];
  onChange: (items: ReferenceDraft[]) => void;
  emptyLabel?: string;
  hint?: string;
  buttonLabel?: string;
};

const ACCEPT = '.jpg,.jpeg,.png,.webp';

/**
 * Local reference list. Reads file data into memory for AI synthesis.
 */
export function ReferencePicker({ items, onChange, emptyLabel, hint, buttonLabel }: ReferencePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const known = new Set(items.map((item) => item.name));
    const newFiles = files.filter((file) => !known.has(file.name));
    if (newFiles.length === 0) {
      event.target.value = '';
      return;
    }

    Promise.all(
      newFiles.map(
        (file) =>
          new Promise<ReferenceDraft>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `${file.name}-${file.lastModified}-${file.size}`,
                name: file.name,
                data: typeof reader.result === 'string' ? reader.result : undefined,
              });
            };
            reader.onerror = () => {
              resolve({
                id: `${file.name}-${file.lastModified}-${file.size}`,
                name: file.name,
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    ).then((added) => {
      onChange([...items, ...added]);
    });
    event.target.value = '';
  };

  return (
    <div className="reference-picker">
      {items.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 10,
            marginBottom: 12,
          }}
        >
          {items.map((item, idx) => (
            <div
              key={item.id || idx}
              style={{
                position: 'relative',
                borderRadius: 8,
                overflow: 'hidden',
                border: '1px solid var(--border-subtle, #333)',
                background: 'var(--bg-surface-subtle, #1c1a17)',
                aspectRatio: '16 / 10',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
              }}
            >
              {(item.data || item.url) ? (
                <img
                  src={item.data ?? item.url}
                  alt={item.name}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 20,
                    color: 'var(--text-muted, #888)',
                  }}
                >
                  🖼️
                </div>
              )}

              {/* Delete button */}
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                title={`Kaldır: ${item.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(items.filter((other) => other.id !== item.id));
                }}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'rgba(0, 0, 0, 0.75)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                  zIndex: 2,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                }}
              >
                ×
              </button>

              {/* Bottom filename badge */}
              <div
                style={{
                  position: 'relative',
                  zIndex: 1,
                  background: 'linear-gradient(transparent, rgba(0,0,0,0.85) 40%)',
                  padding: '4px 6px 3px',
                  fontSize: 10,
                  color: '#fff',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
                title={item.name}
              >
                {item.name}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: '0 0 10px 0', fontSize: 13 }}>
          {emptyLabel ?? 'No references added.'}
        </p>
      )}
      <input
        ref={inputRef}
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={ACCEPT}
        multiple
        onChange={handleFiles}
      />
      <button
        type="button"
        className="button"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        onClick={() => inputRef.current?.click()}
      >
        <span>📁</span> {buttonLabel ?? 'Add reference'}
      </button>
      <p className="field-hint" style={{ marginTop: 6 }}>
        {hint ?? 'JPG, PNG or WEBP. References can be viewed and managed in your workspace.'}
      </p>
    </div>
  );
}
