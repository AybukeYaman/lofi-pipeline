/**
 * Pomodoro durum düzenleyicisi — TEK bileşen, iki yerde kullanılır: proje kurulurken
 * (`NewProject`) ve sonradan değiştirirken (`PomodoroPicker`). Projeyle konuşmaz;
 * seçimi `onChange` ile üst bileşene verir, kaydetmek onun işi. Yalnızca kayıtlı
 * setleri (ad, dakika, bip) kendisi okur/yazar: set projeden bağımsız.
 *
 * Ekran, yukarıdan aşağı:
 *   Hazır düzenler : 50/10 · 30/10 · kendi setlerin (tek tıkla liste dolar)
 *   Liste          : her satır  ⠿ ad · süre · 🔔 bip · ✕ sil — ⠿ tutamacıyla sürükle
 *   + Durum ekle   : STRETCH, LONG BREAK gibi yeni durum
 *   Video süresi   : 1 / 2 / 3 / 4 / 6 saat (arkada tur sayısı)
 *   Set kaydı      : liste hiçbir sete uymuyorsa "Bu listeyi kaydet"
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import { POMODORO_PRESETS } from '../../../core/pomodoro-plan.js';
import { ApiError, createPomodoroSet, deletePomodoroSet, fetchPomodoroSets, updatePomodoroSet } from '../api';
import {
  INTRO_MINUTES,
  MAX_MINUTES,
  MAX_STATUSES,
  MINUTE_CHOICES,
  MIN_MINUTES,
  STATUS_NAME_MAX,
  addStatus,
  cycleMinutes,
  durationLabel,
  hasEmptyName,
  matchingSet,
  moveStatus,
  removeStatus,
  roundChoicesFor,
  roundsKeepingTotal,
  statusesFromSet,
  studyMinutes,
  updateStatus,
  type PomodoroChoice,
} from '../pomodoroSetup';
import type { PomodoroSet } from '../types';

type StatusEditorProps = {
  value: PomodoroChoice;
  onChange: (next: PomodoroChoice) => void;
  disabled?: boolean;
  /** Verilirse "KAPALI" düğmesi çıkar (ayar kutusunda Pomodoro'yu kapatmak için). */
  onTurnOff?: () => void;
  /** Pomodoro kapalıyken yalnızca hazır düzenler görünür; biri seçilince açılır. */
  isOff?: boolean;
};

/** Seçim düğmelerinin ortak ölçüsü — AmbientPicker'daki kutucuklarla aynı. */
const chip = { fontSize: 12, minHeight: 28, padding: '2px 10px' } as const;
const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } as const;

/** Başlangıçta (sunucudan set listesi gelene kadar) yalnızca hazır düzenler görünür. */
const BUILTIN_SETS: PomodoroSet[] = POMODORO_PRESETS.map((preset) => ({
  id: preset.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
  name: preset.id,
  builtin: true,
  statuses: preset.statuses.map(({ name, minutes, beep }) => ({ name, minutes, beep })),
  updatedAt: null,
}));

/** Set kaydı hatasını "ne oldu, ne yapmalı" diye düz Türkçeye çevirir. */
function setErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Bu adla bir set zaten var (ya da ad hazır bir düzene ait). Başka bir ad yaz.';
    if (error.status === 400) return 'Set adında en az bir harf ya da rakam olmalı.';
    if (error.status === 404) return 'Bu set artık yok. Listeyi yenilemek için sayfayı yeniden aç.';
    if (error.status === 422) return error.problems?.join(' ') || 'Set kaydedilemedi: durumlarda bir hata var.';
  }
  return 'Set kaydedilemedi. Bağlantını kontrol edip tekrar dene.';
}

/** Ad kutusu: yazarken yalnızca kutu güncellenir, kutudan çıkınca (ya da Enter ile) kaydedilir. */
function NameInput({ value, disabled, onCommit }: { value: string; disabled?: boolean; onCommit: (name: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = () => {
    if (text !== value) onCommit(text);
  };

  return (
    <input
      className="status-name"
      value={text}
      maxLength={STATUS_NAME_MAX}
      disabled={disabled}
      aria-label="Ekranda görünen yazı"
      title="Videoda bu durumun yazısı olarak görünür"
      placeholder="Yazı"
      aria-invalid={text.trim() === ''}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    />
  );
}

/** Süre kutusu: hazır dakikalar, ya da "Başka süre…" ile elle yazma. */
function MinutesInput({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit: (minutes: number) => void }) {
  const preset = MINUTE_CHOICES.includes(value);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  if (custom) {
    const commit = () => {
      const minutes = Number(text);
      if (Number.isFinite(minutes) && minutes >= MIN_MINUTES) onCommit(minutes);
      else setText(String(value));
    };
    return (
      <span className="status-minutes">
        <input
          type="number"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          value={text}
          disabled={disabled}
          aria-label="Süre (dakika)"
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        />
        <span className="field-hint">dk</span>
        <button type="button" className="button button-compact" style={chip} disabled={disabled} onClick={() => setCustom(false)}>
          Hazır süreler
        </button>
      </span>
    );
  }

  return (
    <select
      className="status-minutes"
      value={value}
      disabled={disabled}
      aria-label="Süre (dakika)"
      onChange={(event) => {
        if (event.target.value === 'custom') setCustom(true);
        else onCommit(Number(event.target.value));
      }}
    >
      {MINUTE_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{minutes} dk</option>)}
      <option value="custom">Başka süre…</option>
    </select>
  );
}

export function StatusEditor({ value, onChange, disabled, onTurnOff, isOff = false }: StatusEditorProps) {
  const [sets, setSets] = useState<PomodoroSet[]>(BUILTIN_SETS);
  const [setsError, setSetsError] = useState<string | null>(null);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [setName, setSetName] = useState('');
  const [setBusy, setSetBusy] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  /** Klavyeyle taşınan satırın yeni sırası: taşıma bitince odak tutamacıyla birlikte gelir. */
  const focusAfterMove = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const reloadSets = async () => {
    try {
      setSets((await fetchPomodoroSets()).sets);
      setSetsError(null);
    } catch {
      setSetsError('Kayıtlı setler yüklenemedi. Hazır düzenleri yine kullanabilirsin.');
    }
  };
  useEffect(() => { void reloadSets(); }, []);
  useEffect(() => {
    if (focusAfterMove.current === null) return;
    listRef.current?.querySelectorAll<HTMLElement>('.status-handle')[focusAfterMove.current]?.focus();
    focusAfterMove.current = null;
  }, [value.statuses]);

  const matched = useMemo(() => matchingSet(value.statuses, sets), [value.statuses, sets]);
  const activeSet = sets.find((set) => set.id === activeSetId && !set.builtin) ?? null;
  const cycle = cycleMinutes(value.statuses);
  const study = studyMinutes(value.statuses, value.rounds);
  const emptyName = hasEmptyName(value.statuses);

  /** Liste değişti: tur sayısı aynı kalır, toplam süre yeni listeye göre yeniden hesaplanır. */
  const changeStatuses = (statuses: PomodoroChoice['statuses']) => onChange({ ...value, statuses });

  const pickSet = (set: PomodoroSet) => {
    const statuses = statusesFromSet(set, value.statuses);
    setActiveSetId(set.id);
    setSaveOpen(false);
    setConfirmDelete(false);
    // Set seçince video süresi korunur (2 saat kalır, tur sayısı ayarlanır).
    onChange({ ...value, statuses, rounds: roundsKeepingTotal(study, statuses) });
  };

  const handleDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (from !== null) changeStatuses(moveStatus(value.statuses, from, to));
  };

  const handleHandleKey = (event: KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= value.statuses.length) return;
    focusAfterMove.current = target;
    changeStatuses(moveStatus(value.statuses, index, target));
  };

  const setPayload = () => value.statuses.map(({ name, minutes, beep }) => ({ name: name.trim(), minutes, beep }));

  const runSetAction = async (action: () => Promise<void>) => {
    setSetBusy(true);
    setSetError(null);
    try {
      await action();
      await reloadSets();
    } catch (error: unknown) {
      setSetError(setErrorText(error));
    } finally {
      setSetBusy(false);
    }
  };

  const saveNew = () => runSetAction(async () => {
    const created = await createPomodoroSet({ name: setName.trim(), statuses: setPayload() });
    setActiveSetId(created.set.id);
    setSaveOpen(false);
    setSetName('');
  });

  const updateActive = () => runSetAction(async () => {
    if (activeSet) await updatePomodoroSet(activeSet.id, { statuses: setPayload() });
  });

  const removeMatched = () => runSetAction(async () => {
    if (matched && !matched.builtin) {
      await deletePomodoroSet(matched.id);
      setActiveSetId(null);
      setConfirmDelete(false);
    }
  });

  return (
    <>
      <div style={row}>
        <span className="field-hint" style={{ marginRight: 4 }}>Düzen:</span>
        {onTurnOff ? (
          <button
            type="button"
            className={isOff ? 'button button-selected' : 'button'}
            aria-pressed={isOff}
            style={chip}
            onClick={onTurnOff}
            disabled={disabled}
          >
            KAPALI
          </button>
        ) : null}
        {sets.filter((set) => !set.error).map((set) => {
          const active = !isOff && matched?.id === set.id;
          return (
            <button
              key={set.id}
              type="button"
              className={active ? 'button button-selected' : 'button'}
              aria-pressed={active}
              style={chip}
              disabled={disabled}
              title={set.statuses.map((status) => `${status.name} ${status.minutes} dk`).join(' → ')}
              onClick={() => pickSet(set)}
            >
              {set.builtin ? set.statuses.map((status) => status.minutes).join(' / ') : set.name}
            </button>
          );
        })}
      </div>
      {setsError ? <p className="field-hint field-error" role="alert">{setsError}</p> : null}

      {isOff ? null : (
        <>
          <ol className="status-list" aria-label="Bir turdaki durumlar" ref={listRef}>
            {value.statuses.map((status, index) => (
              <li
                key={index}
                className={dragOver === index ? 'status-row is-over' : 'status-row'}
                onDragOver={(event) => { if (dragFrom.current !== null) { event.preventDefault(); setDragOver(index); } }}
                onDragLeave={() => setDragOver((current) => (current === index ? null : current))}
                onDrop={(event) => handleDrop(event, index)}
              >
                <button
                  type="button"
                  className="status-handle"
                  draggable={!disabled}
                  disabled={disabled}
                  aria-label={`${status.name || 'Durum'}: sırayı değiştir (sürükle ya da ↑ ↓ tuşları)`}
                  title="Sürükleyerek sırayı değiştir"
                  onDragStart={(event) => { dragFrom.current = index; event.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}
                  onKeyDown={(event) => handleHandleKey(event, index)}
                >
                  ⠿
                </button>
                <NameInput
                  value={status.name}
                  disabled={disabled}
                  onCommit={(name) => changeStatuses(updateStatus(value.statuses, index, { name }))}
                />
                <MinutesInput
                  value={status.minutes}
                  disabled={disabled}
                  onCommit={(minutes) => changeStatuses(updateStatus(value.statuses, index, { minutes }))}
                />
                <button
                  type="button"
                  className={status.beep ? 'button button-selected' : 'button'}
                  aria-pressed={status.beep}
                  style={chip}
                  disabled={disabled}
                  title={status.beep ? 'Bu durum bitmeden 3 saniye önce 3 bip çalar (kapatmak için tıkla)' : 'Bu durumda bip çalmaz (açmak için tıkla)'}
                  onClick={() => changeStatuses(updateStatus(value.statuses, index, { beep: !status.beep }))}
                >
                  {status.beep ? '🔔 Bip' : '🔕 Sessiz'}
                </button>
                <button
                  type="button"
                  className="button button-compact"
                  style={chip}
                  disabled={disabled || value.statuses.length <= 1}
                  aria-label={`${status.name || 'Durum'} durumunu sil`}
                  title={value.statuses.length <= 1 ? 'En az bir durum kalmalı' : 'Bu durumu sil'}
                  onClick={() => changeStatuses(removeStatus(value.statuses, index))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>

          <div style={row}>
            <button
              type="button"
              className="button"
              style={chip}
              disabled={disabled || value.statuses.length >= MAX_STATUSES}
              onClick={() => changeStatuses(addStatus(value.statuses))}
            >
              + Durum ekle
            </button>
            {emptyName || value.statuses.length >= MAX_STATUSES ? (
              <span className={emptyName ? 'field-hint field-error' : 'field-hint'}>
                {emptyName ? 'Her durumun ekranda görünecek bir yazısı olmalı.' : `En fazla ${MAX_STATUSES} durum eklenebilir.`}
              </span>
            ) : null}
          </div>

          <div style={row}>
            <span className="field-hint" style={{ marginRight: 4 }}>Video süresi:</span>
            {roundChoicesFor(value.rounds).map((rounds) => {
              const active = value.rounds === rounds;
              return (
                <button
                  key={rounds}
                  type="button"
                  className={active ? 'button button-selected' : 'button'}
                  aria-pressed={active}
                  style={chip}
                  disabled={disabled}
                  title={`${rounds} tur`}
                  onClick={() => onChange({ ...value, rounds })}
                >
                  {durationLabel(rounds * cycle)}
                </button>
              );
            })}
            <span className="field-hint">
              {value.rounds} tur × {durationLabel(cycle)} · videonun başına {INTRO_MINUTES} dk "GET READY" eklenir
            </span>
          </div>

          {/* --- set kaydı: yalnızca liste hiçbir sete uymuyorsa */}
          {matched === null ? (
            <div style={row}>
              {saveOpen ? (
                <>
                  <input
                    className="status-set-name"
                    autoFocus
                    value={setName}
                    maxLength={60}
                    placeholder="Set adı (örn. Odak 25)"
                    aria-label="Set adı"
                    disabled={setBusy}
                    onChange={(event) => setSetName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && setName.trim() && !emptyName) void saveNew(); }}
                  />
                  <button
                    type="button"
                    className="button button-primary"
                    style={chip}
                    disabled={setBusy || setName.trim() === '' || emptyName}
                    onClick={() => void saveNew()}
                  >
                    Kaydet
                  </button>
                  <button type="button" className="button" style={chip} disabled={setBusy} onClick={() => setSaveOpen(false)}>
                    Vazgeç
                  </button>
                </>
              ) : (
                <>
                  {activeSet ? (
                    <button
                      type="button"
                      className="button"
                      style={chip}
                      disabled={setBusy || emptyName}
                      onClick={() => void updateActive()}
                    >
                      “{activeSet.name}” setini güncelle
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    style={chip}
                    disabled={emptyName}
                    onClick={() => { setSaveOpen(true); setSetError(null); }}
                  >
                    💾 {activeSet ? 'Yeni set olarak kaydet' : 'Bu listeyi set olarak kaydet'}
                  </button>
                  <span className="field-hint">başka projelerde de tek tıkla kullanırsın</span>
                </>
              )}
            </div>
          ) : !matched.builtin ? (
            <div style={row}>
              {confirmDelete ? (
                <>
                  <span className="field-hint">“{matched.name}” seti silinsin mi? Projelerin etkilenmez.</span>
                  <button type="button" className="button" style={chip} disabled={setBusy} onClick={() => void removeMatched()}>
                    Evet, sil
                  </button>
                  <button type="button" className="button" style={chip} disabled={setBusy} onClick={() => setConfirmDelete(false)}>
                    Vazgeç
                  </button>
                </>
              ) : (
                <button type="button" className="button button-compact" style={chip} onClick={() => setConfirmDelete(true)}>
                  “{matched.name}” setini sil
                </button>
              )}
            </div>
          ) : null}
          {setError ? <p className="field-hint field-error" role="alert">{setError}</p> : null}
        </>
      )}
    </>
  );
}
