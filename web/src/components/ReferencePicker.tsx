import { useId, useRef, type ChangeEvent } from 'react';

export type ReferenceDraft = { id: string; name: string };

type ReferencePickerProps = {
  items: ReferenceDraft[];
  onChange: (items: ReferenceDraft[]) => void;
  emptyLabel?: string;
};

const ACCEPT = '.jpg,.jpeg,.png,.webp';

/**
 * Local-only reference list. Only the chosen file names are kept in memory;
 * nothing is uploaded or written to the project folder.
 */
export function ReferencePicker({ items, onChange, emptyLabel }: ReferencePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const known = new Set(items.map((item) => item.name));
    const added = files
      .filter((file) => !known.has(file.name))
      .map((file) => ({ id: `${file.name}-${file.lastModified}-${file.size}`, name: file.name }));
    onChange([...items, ...added]);
    event.target.value = '';
  };

  return (
    <div className="reference-picker">
      {items.length > 0 ? (
        <ul className="chip-list">
          {items.map((item) => (
            <li key={item.id} className="chip">
              <span>{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => onChange(items.filter((other) => other.id !== item.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{emptyLabel ?? 'No references added.'}</p>
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
      <button type="button" className="button" onClick={() => inputRef.current?.click()}>
        Add reference
      </button>
      <p className="field-hint">JPG, PNG or WEBP. Files stay on this screen only (not uploaded yet).</p>
    </div>
  );
}
