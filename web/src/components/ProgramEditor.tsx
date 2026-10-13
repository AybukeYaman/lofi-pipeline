/**
 * Pomodoro program düzenleyicisi — TEK bileşen, iki yerde kullanılır: proje kurulurken
 * (`NewProject`) ve sonradan değiştirirken (`PomodoroPicker`). Projeyle konuşmaz; seçimi
 * `onChange` ile üst bileşene verir, kaydetmek onun işi. Yalnızca hazır/kayıtlı programları
 * kendisi okur/yazar: program projeden bağımsız (görüntü programa girmez).
 *
 * Üç kavram: ADIM (çalışma ya da mola) → SET (art arda adımlar, "× N kez") → LOOP (setlerin
 * tamamı sırayla, sonra başa döner). Ekran, yukarıdan aşağı:
 *   Hazır programlar : 50/10 · 30/10 · 50/10/50/20 · Klasik 25/5 · kayıtlıların
 *   SET kartları     : başlık ⠿ ad · × N kez · ✕; satır ⠿ ad · süre · Çalışma/Mola · 🔔 · ✕
 *   + Set ekle
 *   Loop             : "Bu set sırası kaç kez tekrar etsin?"
 *   Önizleme         : ProgramPreview (canlı)
 *   Program kaydı    : hiçbir programa uymuyorsa "Bu programı kaydet"
 *
 * Sürükle-bırak yerel HTML5 (yeni paket yok); her tutamaç ↑/↓ tuşlarıyla da çalışır.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import { POMODORO_PRESETS, flattenSets } from '../../../core/pomodoro-plan.js';
import {
  ApiError, createPomodoroProgram, deletePomodoroProgram, fetchPomodoroPrograms, updatePomodoroProgram,
} from '../api';
import {
  INTRO_MINUTES,
  MAX_MINUTES,
  MAX_REPEAT,
  MAX_SETS,
  MINUTE_CHOICES,
  MIN_MINUTES,
  STATUS_NAME_MAX,
  addSet,
  addStep,
  canAddSet,
  canAddStep,
  canRepeat,
  cycleMinutes,
  durationLabel,
  hasEmptyName,
  matchingProgram,
  moveSet,
  moveStep,
  removeSet,
  removeStep,
  roundChoicesFor,
  roundsKeepingTotal,
  setsFromProgram,
  setsPayload,
  studyMinutes,
  updateSet,
  updateStep,
  type EditableSet,
  type PomodoroChoice,
  type StepPosition,
} from '../pomodoroSetup';
import type { PomodoroProgram } from '../types';
import { ProgramPreview } from './ProgramPreview';

type ProgramEditorProps = {
  value: PomodoroChoice;
  onChange: (next: PomodoroChoice) => void;
  disabled?: boolean;
  /** Verilirse "KAPALI" düğmesi çıkar (ayar kutusunda Pomodoro'yu kapatmak için). */
  onTurnOff?: () => void;
  /** Pomodoro kapalıyken yalnızca hazır programlar görünür; biri seçilince açılır. */
  isOff?: boolean;
};

/** Seçim düğmelerinin ortak ölçüsü — AmbientPicker'daki kutucuklarla aynı. */
const chip = { fontSize: 12, minHeight: 28, padding: '2px 10px' } as const;
const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } as const;

/** Sunucudan liste gelene kadar yalnızca hazır programlar görünür. */
const BUILTIN_PROGRAMS: PomodoroProgram[] = POMODORO_PRESETS.map((preset) => ({
  id: preset.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
  name: preset.id,
  builtin: true,
  sets: preset.sets.map((set) => ({ ...set, steps: set.steps.map(({ visual: _visual, ...step }) => step) })),
  updatedAt: null,
}));

/** Programın tek satırlık tarifi (düğme ipucu): "SET 1 ×3: STUDY 25 → BREAK 5 | SET 2: …". */
function programTitle(program: PomodoroProgram): string {
  return program.sets
    .map((set) => `${set.name}${set.repeat > 1 ? ` ×${set.repeat}` : ''}: ${set.steps.map((step) => `${step.name} ${step.minutes}`).join(' → ')}`)
    .join(' | ');
}

/** Program kaydı hatasını "ne oldu, ne yapmalı" diye düz Türkçeye çevirir. */
function programErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Bu adla bir program zaten var (ya da ad hazır bir programa ait). Başka bir ad yaz.';
    if (error.status === 400) return 'Program adında en az bir harf ya da rakam olmalı.';
    if (error.status === 404) return 'Bu program artık yok. Listeyi yenilemek için sayfayı yeniden aç.';
    if (error.status === 422) return error.problems?.join(' ') || 'Program kaydedilemedi: adımlarda bir hata var.';
  }
  return 'Program kaydedilemedi. Bağlantını kontrol edip tekrar dene.';
}

/** Ad kutusu: yazarken yalnızca kutu güncellenir, kutudan çıkınca (ya da Enter ile) kaydedilir. */
function NameInput({ value, disabled, label, className, placeholder, onCommit }: {
  value: string; disabled?: boolean; label: string; className: string; placeholder: string; onCommit: (name: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value) onCommit(text); };

  return (
    <input
      className={className}
      value={text}
      maxLength={STATUS_NAME_MAX}
      disabled={disabled}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      aria-invalid={text.trim() === ''}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    />
  );
}

/** Süre kutusu: hazır dakikalar, ya da "Başka süre…" ile elle yazma. */
function MinutesInput({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit: (minutes: number) => void }) {
  // Hazır listede olmayan süre her zaman elle yazma kutusunda görünür: durum değerden türer,
  // satırlar taşınınca (aynı bileşen başka adımı gösterince) eski seçim yanlış adımda kalmaz.
  const [customOpen, setCustom] = useState(false);
  const custom = customOpen || !MINUTE_CHOICES.includes(value);
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
        {MINUTE_CHOICES.includes(value) ? (
          <button type="button" className="button button-compact" style={chip} disabled={disabled} onClick={() => setCustom(false)}>
            Hazır süreler
          </button>
        ) : null}
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

/** Sürüklenen şey: bir set (kart) ya da bir adım (satır). */
type Dragged = { type: 'set'; index: number } | { type: 'step'; at: StepPosition } | null;
/** Bırakma yeri vurgusu: `set` kartın tamamı, `step` o satır. */
type Over = { set: number; step: number | null } | null;

export function ProgramEditor({ value, onChange, disabled, onTurnOff, isOff = false }: ProgramEditorProps) {
  const [programs, setPrograms] = useState<PomodoroProgram[]>(BUILTIN_PROGRAMS);
  const [programsError, setProgramsError] = useState<string | null>(null);
  const [activeProgramId, setActiveProgramId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [programName, setProgramName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dragged = useRef<Dragged>(null);
  const [over, setOver] = useState<Over>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Klavyeyle taşınan şeyin yeni yeri: taşıma bitince odak tutamacıyla birlikte gelir. */
  const focusAfterMove = useRef<string | null>(null);

  const reloadPrograms = async () => {
    try {
      setPrograms((await fetchPomodoroPrograms()).sets);
      setProgramsError(null);
    } catch {
      setProgramsError('Kayıtlı programlar yüklenemedi. Hazır programları yine kullanabilirsin.');
    }
  };
  useEffect(() => { void reloadPrograms(); }, []);
  useEffect(() => {
    if (focusAfterMove.current === null) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-handle="${focusAfterMove.current}"]`)?.focus();
    focusAfterMove.current = null;
  }, [value.sets]);

  const { sets, rounds } = value;
  const flat = useMemo(() => flattenSets(sets), [sets]);
  const matched = useMemo(() => matchingProgram(sets, programs), [sets, programs]);
  const activeProgram = programs.find((program) => program.id === activeProgramId && !program.builtin) ?? null;
  const cycle = cycleMinutes(flat);
  const emptyName = hasEmptyName(sets);

  /** Setler değişti: tur sayısı aynı kalır, toplam süre yeni programa göre yeniden hesaplanır. */
  const changeSets = (next: EditableSet[]) => { if (next !== sets) onChange({ ...value, sets: next }); };

  const pickProgram = (program: PomodoroProgram) => {
    const next = setsFromProgram(program, sets);
    setActiveProgramId(program.id);
    setSaveOpen(false);
    setConfirmDelete(false);
    // Program seçince video süresi olabildiğince korunur (tur sayısı ayarlanır).
    onChange({ sets: next, rounds: roundsKeepingTotal(studyMinutes(flat, rounds), flattenSets(next)) });
  };

  // ------------------------------------------------------------ sürükle-bırak

  const endDrag = () => { dragged.current = null; setOver(null); };

  const allowDrop = (event: DragEvent, target: Over) => {
    if (dragged.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(target);
  };

  /** Bir satırın üstüne bırakıldı: adım oraya; set sürükleniyorsa o kartın yerine. */
  const dropOnStep = (event: DragEvent, at: StepPosition) => {
    event.preventDefault();
    event.stopPropagation();
    const from = dragged.current;
    endDrag();
    if (from?.type === 'step') changeSets(moveStep(sets, from.at, at));
    if (from?.type === 'set') changeSets(moveSet(sets, from.index, at.set));
  };

  /** Kartın boş yerine bırakıldı: adım setin sonuna; set o kartın yerine. */
  const dropOnSet = (event: DragEvent, setIndex: number) => {
    event.preventDefault();
    const from = dragged.current;
    endDrag();
    if (from?.type === 'step') changeSets(moveStep(sets, from.at, { set: setIndex, step: sets[setIndex].steps.length }));
    if (from?.type === 'set') changeSets(moveSet(sets, from.index, setIndex));
  };

  /** Adım tutamacında ↑/↓: set içinde bir sıra; setin ucundaysa komşu sete geçer. */
  const stepKey = (event: KeyboardEvent, at: StepPosition) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const up = event.key === 'ArrowUp';
    let to: StepPosition;
    if (up && at.step > 0) to = { set: at.set, step: at.step - 1 };
    else if (!up && at.step < sets[at.set].steps.length - 1) to = { set: at.set, step: at.step + 1 };
    else if (up && at.set > 0) to = { set: at.set - 1, step: sets[at.set - 1].steps.length };
    else if (!up && at.set < sets.length - 1) to = { set: at.set + 1, step: 0 };
    else return;
    const next = moveStep(sets, at, to);
    if (next === sets) return;
    focusAfterMove.current = `step-${to.set}-${Math.min(to.step, next[to.set].steps.length - 1)}`;
    changeSets(next);
  };

  const setKey = (event: KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= sets.length) return;
    focusAfterMove.current = `set-${to}`;
    changeSets(moveSet(sets, index, to));
  };

  // ------------------------------------------------------------ program kaydı

  const runProgramAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setSaveError(null);
    try {
      await action();
      await reloadPrograms();
    } catch (error: unknown) {
      setSaveError(programErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  const saveNew = () => runProgramAction(async () => {
    const created = await createPomodoroProgram({ name: programName.trim(), sets: setsPayload(sets) });
    setActiveProgramId(created.set.id);
    setSaveOpen(false);
    setProgramName('');
  });

  const updateActive = () => runProgramAction(async () => {
    if (activeProgram) await updatePomodoroProgram(activeProgram.id, { sets: setsPayload(sets) });
  });

  const removeMatched = () => runProgramAction(async () => {
    if (matched && !matched.builtin) {
      await deletePomodoroProgram(matched.id);
      setActiveProgramId(null);
      setConfirmDelete(false);
    }
  });

  // ------------------------------------------------------------ ekran

  return (
    <div ref={rootRef}>
      <div style={row}>
        <span className="field-hint" style={{ marginRight: 4 }}>Hazır programlar:</span>
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
        {programs.filter((program) => !program.error).map((program) => {
          const active = !isOff && matched?.id === program.id;
          return (
            <button
              key={program.id}
              type="button"
              className={active ? 'button button-selected' : 'button'}
              aria-pressed={active}
              style={chip}
              disabled={disabled}
              title={programTitle(program)}
              onClick={() => pickProgram(program)}
            >
              {program.name}
            </button>
          );
        })}
      </div>
      {programsError ? <p className="field-hint field-error" role="alert">{programsError}</p> : null}

      {isOff ? null : (
        <>
          <p className="status-section-title">
            Setler <span className="field-hint">— her set yukarıdan aşağı ilerler, setler sırayla uygulanır</span>
          </p>

          <ol className="program-sets" aria-label="Setler">
            {sets.map((set, setIndex) => (
              <li
                key={setIndex}
                className={over?.set === setIndex && over.step === null ? 'program-set is-over' : 'program-set'}
                onDragOver={(event) => allowDrop(event, { set: setIndex, step: null })}
                onDragLeave={() => setOver((current) => (current?.set === setIndex && current.step === null ? null : current))}
                onDrop={(event) => dropOnSet(event, setIndex)}
              >
                <div className="program-set-head">
                  <button
                    type="button"
                    className="status-handle"
                    data-handle={`set-${setIndex}`}
                    draggable={!disabled}
                    disabled={disabled}
                    aria-label={`${set.name || 'Set'}: set sırasını değiştir (sürükle ya da ↑ ↓ tuşları)`}
                    title="Sürükleyerek setin sırasını değiştir"
                    onDragStart={(event) => { dragged.current = { type: 'set', index: setIndex }; event.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={endDrag}
                    onKeyDown={(event) => setKey(event, setIndex)}
                  >
                    ⠿
                  </button>
                  <NameInput
                    className="program-set-name"
                    value={set.name}
                    disabled={disabled}
                    label="Set adı"
                    placeholder={`SET ${setIndex + 1}`}
                    onCommit={(name) => changeSets(updateSet(sets, setIndex, { name }))}
                  />
                  <label className="program-repeat">
                    <span className="field-hint">Art arda</span>
                    <select
                      value={set.repeat}
                      disabled={disabled}
                      aria-label={`${set.name || 'Set'} kaç kez art arda uygulansın`}
                      onChange={(event) => changeSets(updateSet(sets, setIndex, { repeat: Number(event.target.value) }))}
                    >
                      {Array.from({ length: MAX_REPEAT }, (_, i) => i + 1).map((repeat) => (
                        <option key={repeat} value={repeat} disabled={!canRepeat(sets, setIndex, repeat)}>
                          {repeat} kez
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button button-compact"
                    style={chip}
                    disabled={disabled || sets.length <= 1}
                    aria-label={`${set.name || 'Set'} setini sil`}
                    title={sets.length <= 1 ? 'En az bir set kalmalı' : 'Bu seti sil'}
                    onClick={() => changeSets(removeSet(sets, setIndex))}
                  >
                    ✕
                  </button>
                </div>

                <ol className="status-list" aria-label={`${set.name} adımları`}>
                  {set.steps.map((step, stepIndex) => {
                    const at = { set: setIndex, step: stepIndex };
                    const name = step.name || 'Adım';
                    return (
                      <li
                        key={stepIndex}
                        className={over?.set === setIndex && over.step === stepIndex ? 'status-row is-over' : 'status-row'}
                        onDragOver={(event) => allowDrop(event, { set: setIndex, step: stepIndex })}
                        onDrop={(event) => dropOnStep(event, at)}
                      >
                        <span className="status-index" aria-hidden="true">{stepIndex + 1}</span>
                        <button
                          type="button"
                          className="status-handle"
                          data-handle={`step-${setIndex}-${stepIndex}`}
                          draggable={!disabled}
                          disabled={disabled}
                          aria-label={`${name}: sırayı değiştir (sürükle ya da ↑ ↓ tuşları; başka sete de taşınabilir)`}
                          title="Sürükleyerek sırayı değiştir (başka sete de bırakabilirsin)"
                          onDragStart={(event) => { dragged.current = { type: 'step', at }; event.dataTransfer.effectAllowed = 'move'; event.stopPropagation(); }}
                          onDragEnd={endDrag}
                          onKeyDown={(event) => stepKey(event, at)}
                        >
                          ⠿
                        </button>
                        <NameInput
                          className="status-name"
                          value={step.name}
                          disabled={disabled}
                          label="Ekranda görünen yazı"
                          placeholder="Yazı"
                          onCommit={(next) => changeSets(updateStep(sets, setIndex, stepIndex, { name: next }))}
                        />
                        <MinutesInput
                          value={step.minutes}
                          disabled={disabled}
                          onCommit={(minutes) => changeSets(updateStep(sets, setIndex, stepIndex, { minutes }))}
                        />
                        <button
                          type="button"
                          className={step.kind === 'work' ? 'button program-kind is-work' : 'button program-kind is-break'}
                          style={chip}
                          disabled={disabled}
                          aria-label={`${name}: ${step.kind === 'work' ? 'çalışma' : 'mola'} (değiştirmek için tıkla)`}
                          title="Çalışma mı mola mı? Tıklayınca değişir. Toplamlar ve renkler buna göre."
                          onClick={() => changeSets(updateStep(sets, setIndex, stepIndex, { kind: step.kind === 'work' ? 'break' : 'work' }))}
                        >
                          {step.kind === 'work' ? '🟢 Çalışma' : '🔵 Mola'}
                        </button>
                        <button
                          type="button"
                          className={step.beep ? 'button button-selected' : 'button'}
                          aria-pressed={step.beep}
                          style={chip}
                          disabled={disabled}
                          title={step.beep ? 'Bu adım bitmeden 3 saniye önce 3 bip çalar (kapatmak için tıkla)' : 'Bu adımda bip çalmaz (açmak için tıkla)'}
                          onClick={() => changeSets(updateStep(sets, setIndex, stepIndex, { beep: !step.beep }))}
                        >
                          {step.beep ? '🔔 Bip' : '🔕 Sessiz'}
                        </button>
                        <button
                          type="button"
                          className="button button-compact"
                          style={chip}
                          disabled={disabled || set.steps.length <= 1}
                          aria-label={`${name} adımını sil`}
                          title={set.steps.length <= 1 ? 'Sette en az bir adım kalmalı (seti silmek için başlıktaki ✕)' : 'Bu adımı sil'}
                          onClick={() => changeSets(removeStep(sets, setIndex, stepIndex))}
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ol>

                <div style={row}>
                  <button
                    type="button"
                    className="button"
                    style={chip}
                    disabled={disabled || !canAddStep(sets, setIndex)}
                    title={canAddStep(sets, setIndex) ? 'Bu sete adım ekle' : 'Sınıra ulaşıldı: sette en fazla 8, bir turda en fazla 24 adım'}
                    onClick={() => changeSets(addStep(sets, setIndex))}
                  >
                    + Adım ekle
                  </button>
                </div>
              </li>
            ))}
          </ol>

          <div style={row}>
            <button
              type="button"
              className="button"
              style={chip}
              disabled={disabled || !canAddSet(sets)}
              title={canAddSet(sets) ? 'Programa yeni set ekle' : `En fazla ${MAX_SETS} set ve bir turda 24 adım olabilir`}
              onClick={() => changeSets(addSet(sets))}
            >
              + Set ekle
            </button>
            {emptyName ? (
              <span className="field-hint field-error">Her adımın ve setin bir adı olmalı.</span>
            ) : null}
          </div>

          <div style={row}>
            <span className="field-hint" style={{ marginRight: 4 }}>↻ Bu set sırası kaç kez tekrar etsin?</span>
            {roundChoicesFor(rounds).map((choice) => {
              const active = rounds === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  className={active ? 'button button-selected' : 'button'}
                  aria-pressed={active}
                  style={chip}
                  disabled={disabled}
                  title={`${choice} kez: hazırlık dahil ${durationLabel(choice * cycle + INTRO_MINUTES)} video`}
                  onClick={() => onChange({ ...value, rounds: choice })}
                >
                  {choice} kez · {durationLabel(choice * cycle)}
                </button>
              );
            })}
          </div>

          <ProgramPreview sets={sets} rounds={rounds} />

          {/* --- program kaydı: yalnızca hiçbir programa uymuyorsa */}
          {matched === null ? (
            <div style={row}>
              {saveOpen ? (
                <>
                  <input
                    className="status-set-name"
                    autoFocus
                    value={programName}
                    maxLength={60}
                    placeholder="Program adı (örn. Sabah odak)"
                    aria-label="Program adı"
                    disabled={busy}
                    onChange={(event) => setProgramName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && programName.trim() && !emptyName) void saveNew(); }}
                  />
                  <button
                    type="button"
                    className="button button-primary"
                    style={chip}
                    disabled={busy || programName.trim() === '' || emptyName}
                    onClick={() => void saveNew()}
                  >
                    Kaydet
                  </button>
                  <button type="button" className="button" style={chip} disabled={busy} onClick={() => setSaveOpen(false)}>
                    Vazgeç
                  </button>
                </>
              ) : (
                <>
                  {activeProgram ? (
                    <button type="button" className="button" style={chip} disabled={busy || emptyName} onClick={() => void updateActive()}>
                      “{activeProgram.name}” programını güncelle
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    style={chip}
                    disabled={emptyName}
                    onClick={() => { setSaveOpen(true); setSaveError(null); }}
                  >
                    💾 {activeProgram ? 'Yeni program olarak kaydet' : 'Bu programı kaydet'}
                  </button>
                  <span className="field-hint">başka projelerde de tek tıkla kullanırsın (görüntüler kaydedilmez)</span>
                </>
              )}
            </div>
          ) : !matched.builtin ? (
            <div style={row}>
              {confirmDelete ? (
                <>
                  <span className="field-hint">“{matched.name}” programı silinsin mi? Projelerin etkilenmez.</span>
                  <button type="button" className="button" style={chip} disabled={busy} onClick={() => void removeMatched()}>
                    Evet, sil
                  </button>
                  <button type="button" className="button" style={chip} disabled={busy} onClick={() => setConfirmDelete(false)}>
                    Vazgeç
                  </button>
                </>
              ) : (
                <button type="button" className="button button-compact" style={chip} onClick={() => setConfirmDelete(true)}>
                  “{matched.name}” programını sil
                </button>
              )}
            </div>
          ) : null}
          {saveError ? <p className="field-hint field-error" role="alert">{saveError}</p> : null}
        </>
      )}
    </div>
  );
}
