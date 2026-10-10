import { PageHeader } from '../components/PageHeader';
import { useTheme } from '../theme';

export function Settings() {
  const { theme: currentTheme, selectTheme, themes } = useTheme();

  return (
    <div className="page narrow">
      <PageHeader
        eyebrow="TERCİHLER"
        title="Ayarlar"
        description="Uygulama genel görünümünü ve renk temasını özelleştirin."
      />

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>Renk temaları</h2>
        <p className="field-hint" style={{ marginBottom: 18 }}>
          Seçtiğiniz tema anında tüm sayfalara ve aşamalara uygulanır ve yeniden başlatma sonrasında korunur.
        </p>

        <div className="option-list" style={{ gap: 14 }}>
          {themes.map((item) => {
            const isSelected = item.id === currentTheme;
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`option ${isSelected ? 'selected' : ''}`}
                onClick={() => selectTheme(item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectTheme(item.id);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 18px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  borderWidth: isSelected ? 2 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                  <input
                    type="radio"
                    name="app-theme"
                    id={`theme-${item.id}`}
                    checked={isSelected}
                    onChange={() => selectTheme(item.id)}
                    style={{ cursor: 'pointer' }}
                  />
                  <div style={{ display: 'grid', gap: 4 }}>
                    <label
                      htmlFor={`theme-${item.id}`}
                      style={{ fontWeight: 700, fontSize: 15, cursor: 'pointer', color: 'inherit' }}
                    >
                      {item.name}
                    </label>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {item.description}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-surface-subtle)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  aria-hidden="true"
                >
                  {item.previewColors.map((color) => (
                    <span
                      key={color}
                      style={{
                        display: 'inline-block',
                        width: 20,
                        height: 20,
                        borderRadius: 999,
                        background: color,
                        border: '1px solid rgba(0,0,0,0.15)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                      }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
