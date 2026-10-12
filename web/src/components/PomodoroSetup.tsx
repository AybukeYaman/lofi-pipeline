/**
 * Pomodoro düzen seçimi — TEK bileşen, iki yerde kullanılır: proje kurulurken
 * (`NewProject`) ve sonradan değiştirirken (`PomodoroPicker`). Sunucuyla
 * konuşmaz; seçimi `onChange` ile üst bileşene verir, kaydetmek onun işi.
 *
 * Üç düğme satırı, hepsi hazır seçenek (yazı yazmak yok):
 *   Düzen  : 50/10 · 30/10 (· isteğe bağlı KAPALI)
 *   Süre   : "1 saat · 2 saat · ..." — arkada tur sayısı, kullanıcı süre görür
 *   Sesler : bip + başlangıç sesleri tek düğme
 */

import {
  cycleMinutes,
  durationLabel,
  roundChoicesFor,
  roundsKeepingTotal,
  totalMinutes,
} from '../pomodoroSetup';
import type { PomodoroPreset } from '../types';

export type PomodoroChoice = {
  workMinutes: number;
  breakMinutes: number;
  rounds: number;
  /** Geri sayım bipleri ve oturum başlangıç sesleri. */
  sounds: boolean;
};

type PomodoroSetupProps = {
  presets: PomodoroPreset[];
  value: PomodoroChoice;
  onChange: (next: PomodoroChoice) => void;
  disabled?: boolean;
  /** Verilirse "KAPALI" düğmesi çıkar (ayar kutusunda Pomodoro'yu kapatmak için). */
  onTurnOff?: () => void;
  /** Pomodoro kapalıyken hiçbir düzen seçili görünmez, KAPALI seçili görünür. */
  isOff?: boolean;
};

/** Seçim düğmelerinin ortak ölçüsü — AmbientPicker'daki kutucuklarla aynı. */
const chip = { fontSize: 12, minHeight: 28, padding: '2px 10px' } as const;
const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } as const;

export function PomodoroSetup({ presets, value, onChange, disabled, onTurnOff, isOff = false }: PomodoroSetupProps) {
  const total = totalMinutes(value.workMinutes, value.breakMinutes, value.rounds);

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
        {presets.map((preset) => {
          const active = !isOff && preset.workMinutes === value.workMinutes && preset.breakMinutes === value.breakMinutes;
          return (
            <button
              key={preset.id}
              type="button"
              className={active ? 'button button-selected' : 'button'}
              aria-pressed={active}
              style={chip}
              disabled={disabled}
              title={`${preset.workMinutes} dk çalışma, ${preset.breakMinutes} dk mola`}
              onClick={() => onChange({
                ...value,
                workMinutes: preset.workMinutes,
                breakMinutes: preset.breakMinutes,
                // Düzen değişince video süresi korunur (2 saat kalır, tur sayısı ayarlanır).
                rounds: roundsKeepingTotal(total, preset.workMinutes, preset.breakMinutes),
              })}
            >
              {preset.workMinutes} / {preset.breakMinutes}
            </button>
          );
        })}
        <span className="field-hint">çalışma / mola (dakika)</span>
      </div>

      {isOff ? null : (
        <>
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
                  {durationLabel(rounds * cycleMinutes(value.workMinutes, value.breakMinutes))}
                </button>
              );
            })}
            <span className="field-hint">= {value.rounds} tur</span>
          </div>

          <div style={row}>
            <span className="field-hint" style={{ marginRight: 4 }}>Sesler:</span>
            <button
              type="button"
              className={value.sounds ? 'button button-selected' : 'button'}
              aria-pressed={value.sounds}
              style={chip}
              disabled={disabled}
              title="Her oturumdan 3 saniye önce 3 bip, oturum başında ayrı bir ses"
              onClick={() => onChange({ ...value, sounds: !value.sounds })}
            >
              {value.sounds ? '✓' : '✗'} Bip ve oturum sesleri
            </button>
            <span className="field-hint">her oturumdan 3 sn önce 3 bip</span>
          </div>
        </>
      )}
    </>
  );
}
