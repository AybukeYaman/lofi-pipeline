/**
 * Pomodoro programının canlı önizlemesi: "bu ayarlarla video tam olarak nasıl ilerleyecek?"
 *
 * Her şey sunucunun `buildTimeline`'ından gelir (`programSessions`/`programStats`):
 * burada görünen sıra, videoda, bip ve etiket planında uygulanan sıradır. Sunucuya
 * hiçbir şey yazmaz; `ProgramEditor`'un değerinden çizilir.
 *
 * Yukarıdan aşağı: program akışı (bir turun set kutuları + tekrar işareti), orantılı
 * zaman şeridi, toplamlar, düz Türkçe anlatım, uyarılar, ayrıntılı çizelge (katlı).
 */

import { formatClock } from '../../../core/pomodoro-plan.js';
import {
  describeProgram,
  durationLabel,
  programSessions,
  programStats,
  programWarnings,
  type EditableSet,
} from '../pomodoroSetup';
import type { PomodoroSession } from '../types';

type ProgramPreviewProps = {
  sets: EditableSet[];
  rounds: number;
};

const READY_COLOR = '#b8c1c8';
/** Çalışmalar yeşil/sarı tonlarında, molalar mavi/mor tonlarında; hepsinde koyu yazı okunur. */
const WORK_COLORS = ['#93c7a4', '#b5c48a', '#9fc6c9', '#e6cb7a'];
const BREAK_COLORS = ['#8fb6d9', '#cfb0dd', '#d9a3b8', '#e8a894'];

/** Ad başına renk: aynı adlı adımlar her yerde aynı renkte. */
function colorsByName(sets: EditableSet[]): Map<string, string> {
  const colors = new Map<string, string>();
  let work = 0;
  let rest = 0;
  for (const set of sets) {
    for (const step of set.steps) {
      if (colors.has(step.name)) continue;
      colors.set(step.name, step.kind === 'work'
        ? WORK_COLORS[work++ % WORK_COLORS.length]
        : BREAK_COLORS[rest++ % BREAK_COLORS.length]);
    }
  }
  return colors;
}

/** Şerit parçasının sınıfı: yeni turun başında küçük boşluk. */
function segmentClass(session: PomodoroSession, previous: PomodoroSession | undefined): string {
  return previous && previous.kind === 'status' && previous.round !== session.round ? 'program-seg is-round-start' : 'program-seg';
}

export function ProgramPreview({ sets, rounds }: ProgramPreviewProps) {
  const sessions = programSessions(sets, rounds);
  const stats = programStats(sets, rounds);
  const story = describeProgram(sets, rounds);
  const warnings = programWarnings(sets);
  const colors = colorsByName(sets);
  const colorOf = (session: PomodoroSession) => (session.kind === 'ready' ? READY_COLOR : colors.get(session.name) ?? READY_COLOR);

  return (
    <section className="program-preview" aria-label="Programın önizlemesi">
      <p className="program-preview-title">Program akışı</p>

      {/* Bir turun setleri, sırayla; set tekrarı rozetle. */}
      <ol className="program-flow" aria-label="Bir turdaki setler">
        {sets.map((set, setIndex) => (
          <li key={setIndex} className="program-flow-set">
            <p className="program-flow-head">
              <strong>{set.name || `SET ${setIndex + 1}`}</strong>
              {set.repeat > 1 ? <span className="program-badge" title={`Bu set art arda ${set.repeat} kez uygulanır`}>× {set.repeat}</span> : null}
            </p>
            <ul className="program-flow-steps">
              {set.steps.map((step, stepIndex) => (
                <li key={stepIndex}>
                  <span className="program-dot" style={{ backgroundColor: colors.get(step.name) }} aria-hidden="true" />
                  <span className="program-flow-name">{step.name || '(adsız)'}</span>
                  <span className="field-hint">{step.minutes} dk</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <p className="program-loop">
        ↻ {rounds > 1 ? `Bu set sırası ${rounds} kez tekrarlanır` : 'Bu set sırası bir kez uygulanır'}
      </p>

      {/* Videonun tamamı: genişlik süreyle orantılı, başta 2 dk GET READY. */}
      <div className="program-bar" role="img" aria-label={`Videonun sırası: ${sessions.map((s) => `${s.name} ${s.durationSeconds / 60} dk`).join(', ')}`}>
        {sessions.map((session, index) => (
          <span
            key={index}
            className={segmentClass(session, sessions[index - 1])}
            style={{ flexGrow: session.durationSeconds, backgroundColor: colorOf(session) }}
            title={`${session.label} · ${session.durationSeconds / 60} dk${session.round > 0 ? ` · ${session.round}. tur` : ''}`}
          />
        ))}
      </div>
      <ul className="program-legend" aria-label="Renkler">
        <li><span className="program-dot" style={{ backgroundColor: READY_COLOR }} aria-hidden="true" />GET READY</li>
        {[...colors].map(([name, color]) => (
          <li key={name}><span className="program-dot" style={{ backgroundColor: color }} aria-hidden="true" />{name}</li>
        ))}
      </ul>

      <dl className="program-stats">
        <div><dt>Çalışma</dt><dd>{stats.workCount} kez · {durationLabel(stats.workMinutes)}</dd></div>
        <div><dt>Mola</dt><dd>{stats.breakCount} kez · {durationLabel(stats.breakMinutes)}</dd></div>
        <div><dt>Hazırlık</dt><dd>GET READY · {durationLabel(stats.introMinutes)}</dd></div>
        <div className="is-total"><dt>Video süresi</dt><dd>{durationLabel(stats.totalMinutes)}</dd></div>
      </dl>

      <ul className="program-story">
        {story.map((line) => <li key={line}>{line}</li>)}
      </ul>

      {warnings.map((warning) => (
        <p key={warning} className="field-hint program-warning">⚠ {warning}</p>
      ))}

      <details className="program-details">
        <summary>Ayrıntılı çizelge ({sessions.length} bölüm)</summary>
        <ol>
          {sessions.map((session) => (
            <li key={session.index}>
              <span className="program-dot" style={{ backgroundColor: colorOf(session) }} aria-hidden="true" />
              <strong>{session.label}</strong>
              <span className="field-hint">{formatClock(session.startSeconds)} – {formatClock(session.endSeconds)}</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
