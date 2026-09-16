/**
 * Ink TUI Dashboard view components.
 * 
 * Claude Code style terminal UI screens for lofi pipeline.
 */

import { basename, extname } from 'node:path';

import { Box, Text } from 'ink';
import { h } from './h.js';

/** "C:\...\gentleRain.mp3,C:\...\campfire.mp3" → "gentleRain, campfire" (tam yollar satırları taşırıyordu). */
export function ambientLabel(ambient) {
  if (!ambient || ambient === 'none') return 'none';
  return String(ambient).split(',').map((part) => basename(part.trim(), extname(part.trim()))).filter(Boolean).join(', ') || 'none';
}

/**
 * Ekranda duran "tuşa basılabilir eylem" kutusu. Auto Watch gibi soru sorulmayan
 * (menüsüz) ekranlarda kullanıcı kısayolu tahmin etmek zorunda kalmasın diye,
 * eylem menü maddesi gibi görünür biçimde çizilir. Kapalıyken neden kapalı
 * olduğu da yazar.
 * @param {{ key: string, label: string, enabled: boolean, hint?: string } | null | undefined} hint
 */
export function hotkeyBox(hint) {
  if (!hint) return null;
  const color = hint.enabled ? 'green' : 'gray';
  return h(Box, { borderStyle: 'round', borderColor: color, paddingX: 1, flexDirection: 'column' },
    h(Text, { color, bold: hint.enabled },
      ` ${hint.enabled ? '▶' : '○'} [ ${hint.key} ] ${hint.label}`),
    hint.hint ? h(Text, { dimColor: true }, `    ${hint.hint}`) : null,
  );
}

export function DashboardView({ snap, size }) {
  const { view, projectStatus, promptDetail, watchNotice } = snap;

  if (promptDetail) {
    return h(Box, { flexDirection: 'column', gap: 1 },
      h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'yellow' }, ` 📄 PROMPT OVERLAY: ${promptDetail.title}`),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        h(Text, null, promptDetail.content),
      ),
      h(Text, { dimColor: true }, 'Esc: Overlay Kapat / Geri')
    );
  }

  if (view === 'main') {
    const active = snap.activeProject;
    return h(Box, { flexDirection: 'column', gap: 1 },
      active ? h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexDirection: 'column' },
        h(Box, { flexDirection: 'row', gap: 2 },
          h(Text, { color: 'cyan', bold: true }, 'ACTIVE PROJECT '),
          h(Text, { color: 'green', bold: true }, active.name),
        ),
        h(Box, { flexDirection: 'row', gap: 2 },
          h(Text, { dimColor: true }, 'NEXT STEP      '),
          h(Text, { color: 'yellow', bold: true }, active.step),
        ),
      ) : h(Box, { paddingX: 1 },
        h(Text, { dimColor: true }, 'AI Music Video Production Automation'),
      ),
      h(Box, { borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'magenta' }, 'Projects'),
        snap.projectsList && snap.projectsList.length > 0
          ? h(Box, { flexDirection: 'column', marginTop: 1 },
              ...snap.projectsList.slice(0, 5).map((p) => {
                const isActive = active && (active.dir === p.dir || active.name === p.name);
                if (isActive) {
                  return h(Box, { key: p.name, flexDirection: 'row', justifyContent: 'space-between' },
                    h(Text, { color: 'green', bold: true }, `  ▶ ${p.name.padEnd(26)} ${p.style ?? ''}`),
                    h(Text, { color: 'cyan', bold: true }, '[ active ]'),
                  );
                }
                return h(Text, { key: p.name, dimColor: true }, `    • ${p.name.padEnd(26)} ${p.style ?? ''}`);
              })
            )
          : h(Text, { dimColor: true }, '  No projects found.')
      )
    );
  }

  if (view === 'new-project') {
    return h(Box, { borderStyle: 'round', borderColor: 'magenta', paddingX: 1, flexDirection: 'column' },
      h(Text, { bold: true, color: 'magenta' }, ' ✨ NEW VIDEO PROJECT'),
      h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
      h(Text, { color: 'cyan' }, ' Create automated AI music video project.'),
    );
  }

  if (view === 'project') {
    const s = projectStatus || {};
    const workflow = [
      { id: 'faz1', name: 'Master Frame', label: s.master ? 'Done' : (s.currentStep === 'faz1' ? 'Waiting for image' : 'Pending') },
      { id: 'audio', name: 'Music Tracks', label: s.musicStatus === 'completed_by_user' ? `${s.musicCompletedCount ?? s.audioCount} tracks (completed by user)` : (s.audioCount > 0 ? `${s.audioCount} tracks ready` : (s.currentStep === 'audio' ? 'Selecting music' : 'Pending')) },
      { id: 'faz3', name: 'Image -> Video Clip', label: s.clip?.exists ? 'Done' : (s.currentStep === 'faz3' || s.currentStep === 'clip' ? 'Waiting for video' : 'Pending') },
      { id: 'build', name: 'Assembly & Mix', label: s.output?.exists ? 'Done' : (s.currentStep === 'build' ? 'Building' : 'Pending') },
    ];

    const currentStepObj = workflow.find((w) => w.id === s.currentStep);
    const stepTitle = currentStepObj ? `${currentStepObj.name} [${currentStepObj.label}]` : (s.currentStep || '-');

    return h(Box, { flexDirection: 'column', gap: 1 },
      h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexDirection: 'column' },
        h(Box, { flexDirection: 'row', gap: 2 },
          h(Text, { color: 'cyan', bold: true }, 'ACTIVE PROJECT '),
          h(Text, { color: 'green', bold: true }, s.name || 'Active Project'),
        ),
        h(Box, { flexDirection: 'row', gap: 2 },
          h(Text, { dimColor: true }, 'NEXT STEP      '),
          h(Text, { color: 'yellow', bold: true }, stepTitle),
        ),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        h(Text, null, ` Style:    ${s.style || '-'}`),
        h(Text, null, ` Ambient:  ${ambientLabel(s.ambient)}`),
      ),
      h(Box, { borderStyle: 'round', borderColor: 'blue', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'blue' }, ' Workflow Status'),
        ...workflow.map((item, idx) => {
          let color = 'gray';
          let symbol = '○';
          if (item.label === 'Done' || item.label.includes('tracks ready') || item.label.includes('completed by user')) {
            color = 'green';
            symbol = '✓';
          } else if (item.label.startsWith('Waiting') || item.label.startsWith('Selecting') || item.label.startsWith('Building')) {
            color = 'yellow';
            symbol = '▶';
          }
          return h(Text, { key: item.id, color }, `  ${symbol} ${idx + 1}. ${item.name.padEnd(24)} [${item.label}]`);
        })
      ),
      watchNotice ? h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
        h(Text, { color: 'yellow', bold: true }, ` 📷 Waiting for: ${watchNotice.asset || watchNotice.file || watchNotice}`),
        watchNotice.description ? h(Text, { dimColor: true }, `    ${watchNotice.description}`) : null,
        h(Text, { color: 'cyan' }, ` 📁 Folder: ${watchNotice.folder || 'resimler/'}  |  Expected: ${watchNotice.expected || watchNotice.file || '-'}`),
        watchNotice.folderOpen ? h(Text, { color: 'green', bold: true }, ' 📂 Folder is open in Windows Explorer. Put your file inside.') : null
      ) : null,
      hotkeyBox(snap.actionHint)
    );
  }

  if (view === 'music' && snap.musicState) {
    const { concept, currentTrack, completedCount, totalTracks, tracks } = snap.musicState;
    const activeTrack = currentTrack || (tracks && tracks[0]);

    return h(Box, { flexDirection: 'column', gap: 1 },
      h(Box, { borderStyle: 'round', borderColor: 'magenta', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'magenta' }, ' MUSIC GENERATION'),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        h(Text, { bold: true, color: 'cyan' }, ` Concept: ${concept || '-'}`),
        h(Text, { dimColor: true }, ` Progress: ${completedCount ?? 0} / ${totalTracks ?? 0} completed`),
      ),
      h(Box, { borderStyle: 'round', borderColor: 'blue', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'blue' }, ` Track ${activeTrack ? String(activeTrack.number).padStart(2, '0') : '01'} / ${totalTracks}: "${activeTrack?.title || '-'}"`),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        ...(tracks || []).slice(Math.max(0, (activeTrack?.number || 1) - 3), Math.min((tracks || []).length, (activeTrack?.number || 1) + 2)).map((tr) => {
          let symbol = '○';
          let color = 'gray';
          if (tr.status === 'completed') { symbol = '✓'; color = 'green'; }
          else if (tr.number === activeTrack?.number) { symbol = '▶'; color = 'yellow'; }
          return h(Text, { key: tr.number, color }, `  ${symbol} ${String(tr.number).padStart(2, '0')}  ${tr.title.padEnd(30)} [${tr.status}]`);
        })
      ),
      watchNotice ? h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
        h(Text, { color: 'yellow', bold: true }, ` 🎵 Waiting for: ${watchNotice.asset || `Generated MP3 Track ${activeTrack ? String(activeTrack.number).padStart(2, '0') : '01'}`}`),
        watchNotice.description ? h(Text, { dimColor: true }, `    ${watchNotice.description}`) : h(Text, { dimColor: true }, `    Save Suno generated audio track for "${activeTrack?.title || '-'}" in MP3 format.`),
        h(Text, { color: 'cyan' }, ` 📁 Folder: ${watchNotice.folder || 'audio/'}  |  Expected: ${watchNotice.expected || '*.mp3'}`),
        watchNotice.folderOpen ? h(Text, { color: 'green', bold: true }, ' 📂 Music Folder is open in Windows Explorer. Save MP3 inside.') : null
      ) : null,
      hotkeyBox(snap.actionHint)
    );
  }

  if (view === 'done' && snap.doneState) {
    const { name, output, tracklist } = snap.doneState;
    return h(Box, { flexDirection: 'column', gap: 1 },
      h(Box, { borderStyle: 'round', borderColor: 'green', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'green' }, ' 🎉 PRODUCTION COMPLETE!'),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        h(Text, null, ` Project: ${name || '-'}`),
        h(Text, { wrap: 'truncate' }, ` Output:  ${output || '-'}`),
      ),
      tracklist ? h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
        h(Text, { bold: true, color: 'yellow' }, ' 📋 Tracklist (Açıklama alanına yapıştırılabilir)'),
        h(Text, { dimColor: true }, '─────────────────────────────────────────────────────────────'),
        h(Text, null, tracklist),
      ) : null,
      h(Text, { color: 'magenta', bold: true }, ' 🚀 Video hazır! Şimdi YouTube\'a yükleyebilirsiniz.')
    );
  }

  return null;
}

