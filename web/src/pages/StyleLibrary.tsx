import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  fetchLibrary,
  getStyleDetail,
  createLibraryStyleApi,
  updateStyleDetail,
  deleteStyleDetail,
  ApiError,
} from '../api';
import { EmptyState, SampleDataNotice } from '../components/Feedback';
import { LayoutSwitcher, useCardLayout } from '../components/LayoutSwitcher';
import { PageHeader } from '../components/PageHeader';
import { ReferencePicker, type ReferenceDraft } from '../components/ReferencePicker';
import { StatusBadge } from '../components/StatusBadge';
import { IMAGE_FORMATS_LABEL } from '../imageTypes';
import { sampleStyles, type LibraryStyle } from '../mockData';
import { showError, showSuccess, showInfo, showWarning } from '../toast';
import type { BackendStyle, LoadState, StyleBlock, StyleMusic, StylePaletteColor } from '../types';
import { matchesQuery } from './libraryFilter';

const DRAFT_PALETTE: LibraryStyle['palette'] = ['#4a4540', '#9a9084', '#e2dbd0'];
const CREATE_DRAFT_KEY = 'lofi_style_create_draft';
const EDIT_DRAFT_KEY_PREFIX = 'lofi_style_edit_draft_';

function extractPalette(s: BackendStyle): string[] {
  const block = typeof s.styleBlock === 'object' && s.styleBlock !== null ? (s.styleBlock as StyleBlock) : null;
  if (block && Array.isArray(block.palette)) {
    const hexes = block.palette
      .map((item) => (typeof item === 'string' ? item : item?.hex))
      .filter((hex): hex is string => typeof hex === 'string' && hex.startsWith('#'));
    if (hexes.length > 0) return hexes;
  }
  const sample = sampleStyles.find((item) => item.id === s.name);
  return sample?.palette ?? DRAFT_PALETTE;
}

function extractDescription(s: BackendStyle): string {
  if (s.name === 'custom-generated') {
    return 'Multi-reference visual style synthesizer. Generates custom style block from reference images.';
  }
  if (typeof s.motionHints === 'string' && s.motionHints.trim()) {
    return s.motionHints;
  }
  if (Array.isArray(s.motionHints) && s.motionHints.length > 0) {
    return s.motionHints.join(' · ');
  }
  if (typeof s.styleBlock === 'string' && s.styleBlock.trim()) {
    return s.styleBlock.slice(0, 150);
  }
  if (typeof s.styleBlock === 'object' && s.styleBlock !== null) {
    const block = s.styleBlock as StyleBlock;
    if (block.medium) return block.medium;
  }
  const sample = sampleStyles.find((item) => item.id === s.name);
  return sample?.description || (s.valid ? 'Visual style option.' : 'Invalid style configuration.');
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const DEFAULT_PALETTE_ITEMS: StylePaletteColor[] = [
  { hex: '#1F2A44', role: 'deep navy, outlines and shadows' },
  { hex: '#3E5C8A', role: 'dusk blue, shadow side of forms' },
  { hex: '#6FB3A8', role: 'muted teal, foliage and props' },
  { hex: '#F2C6A0', role: 'warm peach, skin and lit surfaces' },
  { hex: '#FFE8B0', role: 'lamp-light yellow, light sources' },
];

function StyleCardHeader({
  style,
  isCustomGenerated,
}: {
  style: LibraryStyle;
  isCustomGenerated: boolean;
}) {
  const refUrls = (style.refUrls && style.refUrls.length > 0)
    ? style.refUrls
    : style.refUrl
      ? [style.refUrl]
      : [];

  const [activeIdx, setActiveIdx] = useState(0);

  const currentIdx = activeIdx < refUrls.length ? activeIdx : 0;
  const currentUrl = refUrls[currentIdx];

  if (refUrls.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: 80,
          position: 'relative',
          overflow: 'hidden',
          background: `linear-gradient(135deg, ${style.palette[0] || '#2c2a26'} 0%, ${style.palette[1] || '#484237'} 50%, ${style.palette[2] || '#736855'} 100%)`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: '8px 10px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.05em',
              color: 'rgba(255,255,255,0.92)',
              textShadow: '0 1px 3px rgba(0,0,0,0.6)',
              textTransform: 'uppercase',
            }}
          >
            {isCustomGenerated ? '✨ Synthesizer' : '🎨 Preset'}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {style.palette.slice(0, 5).map((color, idx) => (
              <span
                key={idx}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: color,
                  border: '1px solid rgba(255,255,255,0.5)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveIdx((prev) => (prev > 0 ? prev - 1 : refUrls.length - 1));
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveIdx((prev) => (prev < refUrls.length - 1 ? prev + 1 : 0));
  };

  return (
    <div
      style={{
        width: '100%',
        height: 145,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-surface-subtle, #1a1816)',
        userSelect: 'none',
      }}
    >
      <img
        src={currentUrl}
        alt={`${style.name} reference ${currentIdx + 1}`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          transition: 'opacity 0.2s ease',
        }}
        loading="lazy"
      />

      {/* Multi-reference badge & arrow controls if > 1 */}
      {refUrls.length > 1 ? (
        <>
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              background: 'rgba(0, 0, 0, 0.65)',
              backdropFilter: 'blur(4px)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            }}
          >
            <span>🖼️ {currentIdx + 1} / {refUrls.length} Referans</span>
          </div>

          <button
            type="button"
            onClick={handlePrev}
            title="Önceki referans görseli"
            style={{
              position: 'absolute',
              top: '50%',
              left: 6,
              transform: 'translateY(-50%)',
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'rgba(0, 0, 0, 0.55)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 'bold',
              lineHeight: 1,
              padding: 0,
            }}
          >
            ‹
          </button>

          <button
            type="button"
            onClick={handleNext}
            title="Sonraki referans görseli"
            style={{
              position: 'absolute',
              top: '50%',
              right: 6,
              transform: 'translateY(-50%)',
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'rgba(0, 0, 0, 0.55)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 'bold',
              lineHeight: 1,
              padding: 0,
            }}
          >
            ›
          </button>
        </>
      ) : null}

      {/* Bottom Bar: Mini Thumbnails (if > 1) & Palette Dots */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          gap: 6,
        }}
      >
        {refUrls.length > 1 ? (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {refUrls.map((url, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setActiveIdx(idx)}
                style={{
                  width: idx === currentIdx ? 22 : 16,
                  height: 16,
                  borderRadius: 3,
                  border: idx === currentIdx ? '2px solid #fff' : '1px solid rgba(255,255,255,0.4)',
                  padding: 0,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  background: 'transparent',
                  opacity: idx === currentIdx ? 1 : 0.65,
                  transition: 'all 0.15s ease',
                }}
                title={`Referans Görsel ${idx + 1}`}
              >
                <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
          </div>
        ) : <div />}

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {style.palette.slice(0, 5).map((color, idx) => (
            <span
              key={idx}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: color,
                border: '1px solid rgba(255,255,255,0.5)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function StyleLibrary({ onUseStyle }: { onUseStyle?: (styleId: string) => void }) {
  const [backendStyles, setBackendStyles] = useState<BackendStyle[]>([]);
  const [styles, setStyles] = useState<LibraryStyle[]>(sampleStyles);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isBackendConnected, setIsBackendConnected] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [layoutCols, setLayoutCols] = useCardLayout('lofi-layout-styles', 3);

  // Modal / Form states
  const [isAdding, setIsAdding] = useState(false);
  const [createMode, setCreateMode] = useState<'ai' | 'manual'>('ai');

  // AI Create Form State
  const [aiName, setAiName] = useState('');
  const [aiConcept, setAiConcept] = useState('');
  const [aiReferences, setAiReferences] = useState<ReferenceDraft[]>([]);

  // Manual Create Form State
  const [manualReferences, setManualReferences] = useState<ReferenceDraft[]>([]);

  // Manual Create / Edit Form State
  const [editingStyleName, setEditingStyleName] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [editReferences, setEditReferences] = useState<ReferenceDraft[]>([]);
  const [formMedium, setFormMedium] = useState('');
  const [formLines, setFormLines] = useState('');
  const [formPalette, setFormPalette] = useState<StylePaletteColor[]>(DEFAULT_PALETTE_ITEMS);
  const [formLight, setFormLight] = useState('');
  const [formTexture, setFormTexture] = useState('');
  const [formContrast, setFormContrast] = useState('');
  const [formShading, setFormShading] = useState('');
  const [formMotionHints, setFormMotionHints] = useState<string[]>([]);

  // Music DNA Profile Form State
  const [formMusicGenre, setFormMusicGenre] = useState('');
  const [formMusicProduction, setFormMusicProduction] = useState('');
  const [formMusicInstruments, setFormMusicInstruments] = useState('');
  const [formMusicAesthetic, setFormMusicAesthetic] = useState('');
  const [formMusicExclude, setFormMusicExclude] = useState('');

  // Draft persistence notifications
  const [restoredDraftTime, setRestoredDraftTime] = useState<string | null>(null);

  type CreateDraftData = {
    createMode?: 'ai' | 'manual';
    aiName?: string;
    aiConcept?: string;
    aiReferences?: ReferenceDraft[];
    manualReferences?: ReferenceDraft[];
    formName?: string;
    formMedium?: string;
    formLines?: string;
    formPalette?: StylePaletteColor[];
    formLight?: string;
    formTexture?: string;
    formContrast?: string;
    formShading?: string;
    formMotionHints?: string[];
    formMusicGenre?: string;
    formMusicProduction?: string;
    formMusicInstruments?: string;
    formMusicAesthetic?: string;
    formMusicExclude?: string;
    savedAt?: string;
  };

  const [savedCreateDraft, setSavedCreateDraft] = useState<CreateDraftData | null>(null);

  const refreshDrafts = () => {
    try {
      const raw = localStorage.getItem(CREATE_DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          (parsed.aiName ||
            parsed.aiConcept ||
            parsed.formName ||
            parsed.formMedium ||
            (Array.isArray(parsed.aiReferences) && parsed.aiReferences.length > 0) ||
            (Array.isArray(parsed.manualReferences) && parsed.manualReferences.length > 0))
        ) {
          setSavedCreateDraft(parsed);
          return;
        }
      }
    } catch {}
    setSavedCreateDraft(null);
  };

  // Delete modal state
  const [deletingStyle, setDeletingStyle] = useState<string | null>(null);

  // Status & Feedback states
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formProblems, setFormProblems] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadLibrary = async () => {
    try {
      const res = await fetchLibrary();
      if (Array.isArray(res.styles) && res.styles.length > 0) {
        setBackendStyles(res.styles);
        const loadedStyles: LibraryStyle[] = res.styles.map((s) => {
          const sample = sampleStyles.find((item) => item.id === s.name);
          return {
            id: s.name,
            name: sample?.name ?? s.name,
            description: extractDescription(s),
            palette: extractPalette(s),
            refUrl: s.refUrl ?? null,
            refUrls: s.refUrls ?? (s.refUrl ? [s.refUrl] : []),
            references: s.references ?? [],
          };
        });
        setStyles(loadedStyles);
      }
      setIsBackendConnected(true);
      setLoadState('loaded');
    } catch {
      setIsBackendConnected(false);
      setLoadState('loaded');
    }
  };

  useEffect(() => {
    loadLibrary();
    refreshDrafts();
  }, []);

  const visibleStyles = useMemo(
    () => styles.filter((style) => matchesQuery(query, style.name, style.id, style.description)),
    [styles, query],
  );

  const isDraftVisible = useMemo(() => {
    if (!savedCreateDraft || isAdding) return false;
    const dName = savedCreateDraft.aiName || savedCreateDraft.formName || 'İsimsiz Stil Taslağı';
    const dId = slugify(dName);
    const dDesc = savedCreateDraft.aiConcept || savedCreateDraft.formMedium || '';
    return matchesQuery(query, `[Taslak] ${dName}`, dId, dDesc);
  }, [savedCreateDraft, isAdding, query]);

  // Save current form state to LocalStorage as a draft
  const saveDraftToStorage = () => {
    try {
      if (editingStyleName) {
        const draft = {
          styleName: editingStyleName,
          formName,
          formMedium,
          formLines,
          formPalette,
          formLight,
          formTexture,
          formContrast,
          formShading,
          formMotionHints,
          formMusicGenre,
          formMusicProduction,
          formMusicInstruments,
          formMusicAesthetic,
          formMusicExclude,
          editReferences,
          savedAt: new Date().toLocaleTimeString(),
        };
        localStorage.setItem(EDIT_DRAFT_KEY_PREFIX + editingStyleName, JSON.stringify(draft));
      } else if (isAdding) {
        const hasContent =
          aiName ||
          aiConcept ||
          aiReferences.length > 0 ||
          manualReferences.length > 0 ||
          formName ||
          formMedium;
        if (hasContent) {
          const draft = {
            createMode,
            aiName,
            aiConcept,
            aiReferences,
            manualReferences,
            formName,
            formMedium,
            formLines,
            formPalette,
            formLight,
            formTexture,
            formContrast,
            formShading,
            formMotionHints,
            formMusicGenre,
            formMusicProduction,
            formMusicInstruments,
            formMusicAesthetic,
            formMusicExclude,
            savedAt: new Date().toLocaleTimeString(),
          };
          localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(draft));
        }
      }
    } catch {
      // Ignore localstorage errors
    }
    refreshDrafts();
  };

  const closeForm = (saveDraft: boolean = true) => {
    if (saveDraft) {
      saveDraftToStorage();
    }
    setIsAdding(false);
    setEditingStyleName(null);
    setRestoredDraftTime(null);
    setFormError(null);
    setFormProblems([]);
    refreshDrafts();
  };

  const clearCreateDraft = () => {
    try {
      localStorage.removeItem(CREATE_DRAFT_KEY);
    } catch {
      // Ignore
    }
    setRestoredDraftTime(null);
    setSavedCreateDraft(null);
    // Reset to defaults
    setAiName('');
    setAiConcept('');
    setAiReferences([]);
    setManualReferences([]);
    setFormName('');
    setFormMedium('2D anime production still: hand-painted digital background art combined with cel-shaded characters and props.');
    setFormLines('Bold, clean, uniform-weight dark outlines; crisp, confident strokes.');
    setFormPalette(DEFAULT_PALETTE_ITEMS);
    setFormLight('Stylized light defined by shape rather than falloff; soft bloom over flat color.');
    setFormTexture('Clean, flat color fills with subtle grain.');
    setFormContrast('Medium-high contrast between lit and shadow tones.');
    setFormShading('Cel shading: one hard-edged shadow tone per surface, highlights drawn as sharp shapes.');
    setFormMotionHints([
      'rain streaks falling steadily past the window',
      'lamp light flickering softly',
      'hair and clothing edges swaying slightly',
      'steam rising in simple stylized wisps',
    ]);
    setFormMusicGenre('lofi hip hop, chillhop');
    setFormMusicProduction('warm tape saturation, vinyl crackle, gentle sidechain');
    setFormMusicInstruments('dusty Rhodes piano, upright bass, brushed drums');
    setFormMusicAesthetic('late night city apartment, nostalgic, rain on glass');
    setFormMusicExclude('vocals, EDM drops, heavy distortion');
  };

  const clearEditDraft = (styleName: string) => {
    try {
      localStorage.removeItem(EDIT_DRAFT_KEY_PREFIX + styleName);
    } catch {
      // Ignore
    }
    setRestoredDraftTime(null);
    openEditForm(styleName, false); // Reload original from server
  };

  const openCreateForm = () => {
    closeForm(false);
    setEditingStyleName(null);
    setFormError(null);
    setFormProblems([]);

    // Check if a saved draft exists
    let hasDraft = false;
    try {
      const raw = localStorage.getItem(CREATE_DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft) {
          setCreateMode(draft.createMode || 'ai');
          setAiName(draft.aiName || '');
          setAiConcept(draft.aiConcept || '');
          setAiReferences(Array.isArray(draft.aiReferences) ? draft.aiReferences : []);
          setManualReferences(Array.isArray(draft.manualReferences) ? draft.manualReferences : []);
          setFormName(draft.formName || '');
          setFormMedium(draft.formMedium || '');
          setFormLines(draft.formLines || '');
          setFormPalette(Array.isArray(draft.formPalette) ? draft.formPalette : DEFAULT_PALETTE_ITEMS);
          setFormLight(draft.formLight || '');
          setFormTexture(draft.formTexture || '');
          setFormContrast(draft.formContrast || '');
          setFormShading(draft.formShading || '');
          setFormMotionHints(Array.isArray(draft.formMotionHints) ? draft.formMotionHints : []);
          setFormMusicGenre(draft.formMusicGenre || '');
          setFormMusicProduction(draft.formMusicProduction || '');
          setFormMusicInstruments(draft.formMusicInstruments || '');
          setFormMusicAesthetic(draft.formMusicAesthetic || '');
          setFormMusicExclude(draft.formMusicExclude || '');
          setRestoredDraftTime(draft.savedAt || 'Önceki oturum');
          hasDraft = true;
        }
      }
    } catch {
      // Ignore
    }

    if (!hasDraft) {
      clearCreateDraft();
    }
    setIsAdding(true);
  };

  const openEditForm = async (styleName: string, checkDraft: boolean = true) => {
    // 1. Immediately open form and start with available state
    setIsAdding(false);
    setEditingStyleName(styleName);
    setRestoredDraftTime(null);
    setFormError(null);
    setFormProblems([]);

    // Smooth scroll to top of page so the form is immediately in focus
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Populate instantly from backendStyles if already loaded
    const initialDetail = backendStyles.find((s) => s.name === styleName);
    const initialBlock = typeof initialDetail?.styleBlock === 'object' && initialDetail?.styleBlock !== null
      ? (initialDetail.styleBlock as StyleBlock)
      : null;

    setFormName(styleName);
    setFormMedium(initialBlock?.medium || '');
    setFormLines(initialBlock?.lines || '');
    setFormLight(initialBlock?.light || '');
    setFormTexture(initialBlock?.texture || '');
    setFormContrast(initialBlock?.contrast || '');
    setFormShading(initialBlock?.shading || '');

    if (initialBlock?.palette && Array.isArray(initialBlock.palette) && initialBlock.palette.length > 0) {
      setFormPalette(
        initialBlock.palette.map((p) =>
          typeof p === 'string' ? { hex: p, role: 'accent color' } : { hex: p.hex || '#ffffff', role: p.role || '' },
        ),
      );
    } else {
      setFormPalette(DEFAULT_PALETTE_ITEMS);
    }

    if (Array.isArray(initialDetail?.motionHints)) {
      setFormMotionHints(initialDetail.motionHints);
    } else if (typeof initialDetail?.motionHints === 'string') {
      setFormMotionHints(initialDetail.motionHints.split('\n').filter(Boolean));
    } else {
      setFormMotionHints([]);
    }

    const initialRefs: ReferenceDraft[] = [];
    if (Array.isArray(initialDetail?.references) && initialDetail.references.length > 0) {
      initialDetail.references.forEach((r, idx) => {
        initialRefs.push({
          id: `existing-${idx}-${r.name}`,
          name: r.name,
          url: r.url,   // mevcut → url (data değil)
        });
      });
    } else if (initialDetail?.refUrl) {
      initialRefs.push({
        id: `existing-0-${styleName}`,
        name: `${styleName}.png`,
        url: initialDetail.refUrl,   // mevcut → url
      });
    }
    setEditReferences(initialRefs);

    const initialMusic = initialDetail?.music;
    setFormMusicGenre(initialMusic?.genre || '');
    setFormMusicProduction(Array.isArray(initialMusic?.production) ? initialMusic.production.join(', ') : '');
    setFormMusicInstruments(Array.isArray(initialMusic?.instruments) ? initialMusic.instruments.join(', ') : '');
    setFormMusicAesthetic(initialMusic?.aesthetic || '');
    setFormMusicExclude(Array.isArray(initialMusic?.exclude) ? initialMusic.exclude.join(', ') : '');

    try {
      // Check if there is an existing draft for this style
      let loadedFromDraft = false;
      if (checkDraft) {
        try {
          const raw = localStorage.getItem(EDIT_DRAFT_KEY_PREFIX + styleName);
          if (raw) {
            const draft = JSON.parse(raw);
            if (draft) {
              setFormName(draft.formName || styleName);
              setFormMedium(draft.formMedium || '');
              setFormLines(draft.formLines || '');
              setFormPalette(Array.isArray(draft.formPalette) ? draft.formPalette : DEFAULT_PALETTE_ITEMS);
              setFormLight(draft.formLight || '');
              setFormTexture(draft.formTexture || '');
              setFormContrast(draft.formContrast || '');
              setFormShading(draft.formShading || '');
              setFormMotionHints(Array.isArray(draft.formMotionHints) ? draft.formMotionHints : []);
              setFormMusicGenre(draft.formMusicGenre || '');
              setFormMusicProduction(draft.formMusicProduction || '');
              setFormMusicInstruments(draft.formMusicInstruments || '');
              setFormMusicAesthetic(draft.formMusicAesthetic || '');
              setFormMusicExclude(draft.formMusicExclude || '');
              setEditReferences(Array.isArray(draft.editReferences) ? draft.editReferences : []);
              setRestoredDraftTime(draft.savedAt || 'Önceki oturum');
              loadedFromDraft = true;
            }
          }
        } catch {
          // Ignore
        }
      }

      if (!loadedFromDraft) {
        // Fetch fresh detail from server in background
        const detail = await getStyleDetail(styleName);

        setFormName(styleName);
        const block = typeof detail?.styleBlock === 'object' && detail?.styleBlock !== null
          ? (detail.styleBlock as StyleBlock)
          : null;

        setFormMedium(block?.medium || '');
        setFormLines(block?.lines || '');
        setFormLight(block?.light || '');
        setFormTexture(block?.texture || '');
        setFormContrast(block?.contrast || '');
        setFormShading(block?.shading || '');

        if (block?.palette && Array.isArray(block.palette) && block.palette.length > 0) {
          setFormPalette(
            block.palette.map((p) =>
              typeof p === 'string' ? { hex: p, role: 'accent color' } : { hex: p.hex || '#ffffff', role: p.role || '' },
            ),
          );
        } else {
          setFormPalette(DEFAULT_PALETTE_ITEMS);
        }

        if (Array.isArray(detail?.motionHints)) {
          setFormMotionHints(detail.motionHints);
        } else if (typeof detail?.motionHints === 'string') {
          setFormMotionHints(detail.motionHints.split('\n').filter(Boolean));
        } else {
          setFormMotionHints([]);
        }

        // Referansları yalnızca kullanıcı henüz eklemediyse güncelle
        // (setEditReferences ilk yükleme sırasında zaten dolduruldu)
        setEditReferences((current) => {
          // Eğer kullanıcı zaten bir şeyler eklemiş / değiştirmişse dokunma
          const hasNewUploads = current.some((r) => r.data);
          if (hasNewUploads) return current;

          const existingRefs: ReferenceDraft[] = [];
          if (Array.isArray(detail?.references) && detail.references.length > 0) {
            detail.references.forEach((r, idx) => {
              existingRefs.push({
                id: `existing-${idx}-${r.name}`,
                name: r.name,
                url: r.url,
              });
            });
          } else if (detail?.refUrl) {
            existingRefs.push({
              id: `existing-0-${styleName}`,
              name: `${styleName}.png`,
              url: detail.refUrl,
            });
          }
          return existingRefs;
        });

        const music = detail?.music;
        setFormMusicGenre(music?.genre || '');
        setFormMusicProduction(Array.isArray(music?.production) ? music.production.join(', ') : '');
        setFormMusicInstruments(Array.isArray(music?.instruments) ? music.instruments.join(', ') : '');
        setFormMusicAesthetic(music?.aesthetic || '');
        setFormMusicExclude(Array.isArray(music?.exclude) ? music.exclude.join(', ') : '');
      }
    } catch (err: unknown) {
      showError(err, 'Stil detayları yüklenirken hata oluştu.');
      setFormError(err instanceof Error ? err.message : 'Could not load style details.');
    }
  };

  // Edit formunda referanslardan prompt yenileme
  const [isRegenerating, setIsRegenerating] = useState(false);

  const handleRegenerateFromReferences = async () => {
    if (!editingStyleName || isRegenerating || isSaving) return;
    if (editReferences.length === 0) {
      showError(new Error('Önce en az bir referans görsel ekleyin.'));
      return;
    }

    setIsRegenerating(true);
    setFormError(null);

    try {
      // 1. Referansları önce kaydet (sunucuya gönder)
      const resolvedRefs = await Promise.all(
        editReferences.map(async (ref) => {
          if (ref.data) {
            if (ref.data.startsWith('data:')) return { name: ref.name, data: ref.data };
            try {
              const resp = await fetch(ref.data);
              const blob = await resp.blob();
              return new Promise<{ name: string; data: string } | null>((res) => {
                const reader = new FileReader();
                reader.onload = () => res({ name: ref.name, data: reader.result as string });
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          }
          if (ref.url) {
            try {
              const resp = await fetch(ref.url);
              const blob = await resp.blob();
              return new Promise<{ name: string; data: string } | null>((res) => {
                const reader = new FileReader();
                reader.onload = () => res({ name: ref.name, data: reader.result as string });
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          }
          return null;
        }),
      );
      const validRefs = resolvedRefs.filter((r): r is { name: string; data: string } => r !== null);

      // 2. Referansları kaydet + Gemini ile yeniden analiz et
      showInfo('🤖 Gemini referans görsellerini analiz ediyor...', 'Analiz Başladı');
      const result = await updateStyleDetail(editingStyleName, {
        name: formName.trim() || editingStyleName,
        referenceImages: validRefs,
        regenerate: true,
        music: (formMusicGenre.trim() || formMusicAesthetic.trim()) ? {
          genre: formMusicGenre.trim() || undefined,
          production: formMusicProduction ? formMusicProduction.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          instruments: formMusicInstruments ? formMusicInstruments.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          aesthetic: formMusicAesthetic.trim() || undefined,
          exclude: formMusicExclude ? formMusicExclude.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        } : undefined,
      });

      // 3. Form alanlarını AI çıktısıyla güncelle
      const updatedStyle = result.style;
      const block = typeof updatedStyle?.styleBlock === 'object' && updatedStyle?.styleBlock !== null
        ? (updatedStyle.styleBlock as import('../types').StyleBlock)
        : null;

      if (block?.medium) setFormMedium(block.medium);
      if (block?.lines) setFormLines(block.lines);
      if (block?.light) setFormLight(block.light);
      if (block?.texture) setFormTexture(block.texture);
      if (block?.contrast) setFormContrast(block.contrast);
      if (block?.shading) setFormShading(block.shading);

      if (block?.palette && Array.isArray(block.palette) && block.palette.length > 0) {
        setFormPalette(
          block.palette.map((p) =>
            typeof p === 'string' ? { hex: p, role: 'accent color' } : { hex: p.hex || '#ffffff', role: p.role || '' },
          ),
        );
      }

      if (Array.isArray(updatedStyle?.motionHints) && updatedStyle.motionHints.length > 0) {
        setFormMotionHints(updatedStyle.motionHints);
      }

      // 4. Güncellenmiş referansları forma yükle
      if (Array.isArray(updatedStyle?.references) && updatedStyle.references.length > 0) {
        setEditReferences(
          updatedStyle.references.map((r, idx) => ({
            id: `existing-${idx}-${r.name}`,
            name: r.name,
            url: r.url,
          })),
        );
      }

      showSuccess('✨ Prompt alanları referans görsellerden güncellendi!', 'Analiz Tamamlandı');
    } catch (err: unknown) {
      showError(err, 'Gemini analizi sırasında hata oluştu.');
      setFormError(err instanceof Error ? err.message : 'Regeneration failed.');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleAddPaletteColor = () => {
    if (formPalette.length >= 8) return;
    setFormPalette((prev) => [...prev, { hex: '#5c523b', role: 'accent tone' }]);
  };

  const handleUpdatePaletteColor = (index: number, hex: string, role: string) => {
    setFormPalette((prev) => {
      const next = [...prev];
      next[index] = { hex, role };
      return next;
    });
  };

  const handleRemovePaletteColor = (index: number) => {
    if (formPalette.length <= 3) return; // Keep minimum 3
    setFormPalette((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddMotionHint = () => {
    setFormMotionHints((prev) => [...prev, '']);
  };

  const handleUpdateMotionHint = (index: number, text: string) => {
    setFormMotionHints((prev) => {
      const next = [...prev];
      next[index] = text;
      return next;
    });
  };

  const handleRemoveMotionHint = (index: number) => {
    setFormMotionHints((prev) => prev.filter((_, i) => i !== index));
  };

  // Submit AI synthesis style creation
  const handleCreateAiStyle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;

    const rawName = aiName.trim();
    const styleId = slugify(rawName);

    if (!rawName) {
      showError(new Error('Stil adı (ID) zorunludur.'));
      setFormError('Image style name is required.');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(styleId)) {
      showError(new Error('Stil ID formatı küçük harf ve tire içermelidir (ör. cyber-lofi).'));
      setFormError('Use lowercase letters, numbers and hyphens (e.g. cyber-lofi).');
      return;
    }
    if (styles.some((s) => s.id === styleId)) {
      showError(new Error(`"${styleId}" isimli bir stil zaten mevcut.`));
      setFormError(`An image style with ID "${styleId}" already exists.`);
      return;
    }

    setIsSaving(true);
    setFormError(null);
    setFormProblems([]);
    setSuccessMessage(null);

    try {
      const payload = {
        name: styleId,
        concept: aiConcept.trim() || undefined,
        referenceImages: aiReferences.map((r) => ({ name: r.name, data: r.data })),
      };

      await createLibraryStyleApi(payload);
      try {
        localStorage.removeItem(CREATE_DRAFT_KEY);
      } catch {
        // Ignore
      }

      await loadLibrary();
      setSelectedId(styleId);
      const msg = `Görsel stil "${styleId}" Gemini AI ile başarıyla üretildi ve kütüphaneye eklendi!`;
      setSuccessMessage(msg);
      showSuccess(msg, 'Stil Üretildi');
      closeForm(false);
    } catch (err: unknown) {
      showError(err, 'Görsel stil sentezlenirken bir hata oluştu.');
      if (err instanceof ApiError) {
        setFormError(err.message);
        if (err.problems) setFormProblems(err.problems);
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not generate custom image style.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Submit Manual Style Creation / Update
  const handleSaveManualStyle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;

    const rawName = formName.trim();
    const styleId = slugify(rawName);

    if (!rawName) {
      showError(new Error('Stil adı zorunludur.'));
      setFormError('Image style name is required.');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(styleId)) {
      showError(new Error('Stil ID formatı küçük harf ve tire içermelidir.'));
      setFormError('Use lowercase letters, numbers and hyphens (e.g. cozy-realistic).');
      return;
    }

    const isEdit = Boolean(editingStyleName);

    if (!isEdit && styles.some((s) => s.id === styleId)) {
      showError(new Error(`"${styleId}" isimli bir stil zaten mevcut.`));
      setFormError(`An image style with ID "${styleId}" already exists.`);
      return;
    }

    // Build payload
    const styleBlock: StyleBlock = {
      medium: formMedium.trim(),
      lines: formLines.trim(),
      palette: formPalette.map((p) => ({
        hex: p.hex.startsWith('#') ? p.hex.toUpperCase() : `#${p.hex.toUpperCase()}`,
        role: p.role.trim() || 'color tone',
      })),
      light: formLight.trim(),
      texture: formTexture.trim(),
      contrast: formContrast.trim(),
      shading: formShading.trim(),
    };

    const cleanHints = formMotionHints.map((h) => h.trim()).filter(Boolean);

    const music: StyleMusic | undefined = (formMusicGenre.trim() || formMusicAesthetic.trim())
      ? {
          genre: formMusicGenre.trim() || undefined,
          production: formMusicProduction ? formMusicProduction.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          instruments: formMusicInstruments ? formMusicInstruments.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          aesthetic: formMusicAesthetic.trim() || undefined,
          exclude: formMusicExclude ? formMusicExclude.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        }
      : undefined;

    // Resolve reference images for save
    const targetReferences = isEdit ? editReferences : manualReferences;
    let resolvedRefImages: { name: string; data: string }[] | undefined = undefined;

    if (targetReferences.length > 0) {
      const resolved = await Promise.all(
        targetReferences.map(async (ref) => {
          // 1. Yeni yükleme: base64 data URL
          if (ref.data) {
            if (ref.data.startsWith('data:')) {
              return { name: ref.name, data: ref.data };
            }
            // data alanı data: ile başlamıyorsa URL olarak fetch et
            try {
              const resp = await fetch(ref.data);
              const blob = await resp.blob();
              return new Promise<{ name: string; data: string } | null>((res) => {
                const reader = new FileReader();
                reader.onload = () => res({ name: ref.name, data: reader.result as string });
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
              });
            } catch {
              return null;
            }
          }
          // 2. Mevcut sunucu referansı: url üzerinden fetch et
          if (ref.url) {
            try {
              const resp = await fetch(ref.url);
              const blob = await resp.blob();
              return new Promise<{ name: string; data: string } | null>((res) => {
                const reader = new FileReader();
                reader.onload = () => res({ name: ref.name, data: reader.result as string });
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
              });
            } catch {
              return null;
            }
          }
          return null;
        }),
      );
      resolvedRefImages = resolved.filter((r): r is { name: string; data: string } => r !== null);
    }

    const payload = {
      name: styleId,
      styleBlock,
      motionHints: cleanHints,
      music,
      referenceImages: resolvedRefImages,
      overwrite: isEdit,
    };

    setIsSaving(true);
    setFormError(null);
    setFormProblems([]);
    setSuccessMessage(null);

    try {
      if (isEdit) {
        await updateStyleDetail(editingStyleName!, payload);
        try {
          localStorage.removeItem(EDIT_DRAFT_KEY_PREFIX + editingStyleName);
          if (styleId !== editingStyleName) {
            localStorage.removeItem(EDIT_DRAFT_KEY_PREFIX + styleId);
          }
        } catch {
          // Ignore
        }
        const msg = `Görsel stil "${styleId}" başarıyla güncellendi!`;
        setSuccessMessage(msg);
        showSuccess(msg, 'Güncellendi');
      } else {
        await createLibraryStyleApi(payload);
        try {
          localStorage.removeItem(CREATE_DRAFT_KEY);
        } catch {
          // Ignore
        }
        const msg = `Görsel stil "${styleId}" başarıyla kaydedildi!`;
        setSuccessMessage(msg);
        showSuccess(msg, 'Stil Kaydedildi');
      }

      await loadLibrary();
      setSelectedId(styleId);
      closeForm(false);
    } catch (err: unknown) {
      showError(err, 'Stil kaydedilirken bir hata oluştu.');
      if (err instanceof ApiError) {
        setFormError(err.message);
        if (err.problems) setFormProblems(err.problems);
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save image style.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Delete Style
  const handleDeleteStyle = async () => {
    if (!deletingStyle || isSaving) return;
    setIsSaving(true);
    setFormError(null);
    try {
      await deleteStyleDetail(deletingStyle);
      try {
        localStorage.removeItem(EDIT_DRAFT_KEY_PREFIX + deletingStyle);
      } catch {
        // Ignore
      }
      if (selectedId === deletingStyle) setSelectedId(null);
      const msg = `Görsel stil "${deletingStyle}" silindi.`;
      setSuccessMessage(msg);
      showSuccess(msg, 'Stil Silindi');
      setDeletingStyle(null);
      await loadLibrary();
    } catch (err: unknown) {
      showError(err, 'Stil silinirken hata oluştu.');
      setFormError(err instanceof Error ? err.message : 'Could not delete image style.');
    } finally {
      setIsSaving(false);
    }
  };

  const selectedStyle = styles.find((s) => s.id === selectedId);

  return (
    <section className="page">
      <PageHeader
        eyebrow="LIBRARY"
        title="Image Styles"
        actions={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {selectedStyle && onUseStyle ? (
              <button
                className="button button-primary"
                type="button"
                onClick={() => onUseStyle(selectedStyle.id)}
              >
                Use in New Project ({selectedStyle.name}) →
              </button>
            ) : null}
            {!isAdding && !editingStyleName ? (
              <button
                className="button button-primary"
                type="button"
                onClick={openCreateForm}
                aria-expanded={false}
              >
                ＋ Create Image Style
              </button>
            ) : null}
          </div>
        }
      />

      {isBackendConnected ? null : <SampleDataNotice />}

      {successMessage ? (
        <div className="notice" style={{ borderColor: '#cfe0d2', background: '#e9f2ea', color: '#34603f', marginBottom: 20 }}>
          <strong>✓ Success:</strong> {successMessage}
        </div>
      ) : null}

      {/* CREATE FORM */}
      {isAdding ? (
        <div className="panel" style={{ marginBottom: 28, borderLeft: '4px solid var(--primary)' }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>Create New Image Style</h2>
              <p className="field-hint" style={{ margin: '4px 0 0' }}>
                Define a visual style template for AI video prompt generation. (Kapatıldığında taslağınız otomatik korunur)
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6, background: 'var(--bg-surface-subtle)', padding: 4, borderRadius: 8 }}>
                <button
                  type="button"
                  className={`button ${createMode === 'ai' ? 'button-primary' : ''}`}
                  style={{ fontSize: 13, padding: '6px 12px' }}
                  onClick={() => setCreateMode('ai')}
                >
                  ✨ AI Vision Sentezi
                </button>
                <button
                  type="button"
                  className={`button ${createMode === 'manual' ? 'button-primary' : ''}`}
                  style={{ fontSize: 13, padding: '6px 12px' }}
                  onClick={() => setCreateMode('manual')}
                >
                  ✍️ Manuel Tasarla
                </button>
              </div>
              <button
                type="button"
                className="toast-close"
                style={{ fontSize: 22, width: 32, height: 32 }}
                onClick={() => closeForm(true)}
                title="Kapat (Taslak korunur)"
                aria-label="Kapat"
              >
                ×
              </button>
            </div>
          </header>

          {/* Restored Draft Alert */}
          {restoredDraftTime ? (
            <div
              className="notice"
              style={{
                borderColor: '#e5dccb',
                background: '#faf7f0',
                color: '#5c523b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 16,
              }}
            >
              <div>
                <strong>📝 Yarım kalan taslak yüklendi</strong> <span className="muted">({restoredDraftTime})</span>
              </div>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, padding: '2px 8px' }}
                onClick={clearCreateDraft}
              >
                🗑️ Taslağı Sıfırla
              </button>
            </div>
          ) : null}

          {formError ? (
            <div className="state-card" role="alert" style={{ borderColor: '#b5654f', color: '#97432c', marginBottom: 16 }}>
              <strong>{formError}</strong>
              {formProblems.length > 0 ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {formProblems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {createMode === 'ai' ? (
            <form onSubmit={handleCreateAiStyle} noValidate>
              <div className="field">
                <label htmlFor="ai-style-name">Image Style Name (ID)</label>
                <input
                  id="ai-style-name"
                  value={aiName}
                  placeholder="e.g. rainy-cyberpunk-lofi"
                  onChange={(event) => setAiName(event.target.value)}
                  autoComplete="off"
                  disabled={isSaving}
                  required
                />
                <p className="field-hint">
                  Saved as kebab-case ID: <code>{slugify(aiName || 'style-name')}</code>
                </p>
              </div>

              <div className="field">
                <label htmlFor="ai-style-concept">Style Concept & Ambience Prompt (Optional)</label>
                <textarea
                  id="ai-style-concept"
                  rows={2}
                  placeholder="e.g. Rainy neon street lights reflecting on wet asphalt with muted warm colors"
                  value={aiConcept}
                  onChange={(event) => setAiConcept(event.target.value)}
                  disabled={isSaving}
                />
                <p className="field-hint">Used by Gemini to guide color palette synthesis and atmosphere extraction.</p>
              </div>

              <fieldset className="field">
                <legend>Reference Images</legend>
                <ReferencePicker
                  items={aiReferences}
                  onChange={setAiReferences}
                  emptyLabel={`Add reference images (${IMAGE_FORMATS_LABEL}) to extract visual style`}
                />
              </fieldset>

              <div className="form-actions" style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <button className="button button-primary" type="submit" disabled={isSaving}>
                  {isSaving ? '✨ Generating Image Style with Gemini...' : '✨ Create Image Style'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSaveManualStyle} noValidate>
              <div className="field">
                <label htmlFor="manual-name">Image Style Name (ID)</label>
                <input
                  id="manual-name"
                  value={formName}
                  placeholder="e.g. anime-cozy-dusk"
                  onChange={(event) => setFormName(event.target.value)}
                  autoComplete="off"
                  disabled={isSaving}
                  required
                />
              </div>

              <fieldset className="field" style={{ marginBottom: 16 }}>
                <legend style={{ fontWeight: 600 }}>Reference Images ({manualReferences.length} Görsel - Opsiyonel)</legend>
                <ReferencePicker
                  items={manualReferences}
                  onChange={setManualReferences}
                  emptyLabel={`Referans görseli ekle (${IMAGE_FORMATS_LABEL})`}
                  buttonLabel="＋ Referans Görseli Ekle"
                />
              </fieldset>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <div className="field">
                  <label htmlFor="form-medium">Medium / Technique</label>
                  <textarea
                    id="form-medium"
                    rows={2}
                    value={formMedium}
                    onChange={(e) => setFormMedium(e.target.value)}
                    placeholder="2D anime production still: hand-painted digital background art..."
                    disabled={isSaving}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="form-lines">Line Quality</label>
                  <textarea
                    id="form-lines"
                    rows={2}
                    value={formLines}
                    onChange={(e) => setFormLines(e.target.value)}
                    placeholder="Bold, clean, uniform-weight dark outlines..."
                    disabled={isSaving}
                    required
                  />
                </div>
              </div>

              {/* Palette Builder */}
              <fieldset className="field" style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <legend style={{ fontWeight: 600 }}>Color Palette ({formPalette.length} Colors - Min 3, Max 8)</legend>
                  {formPalette.length < 8 ? (
                    <button type="button" className="button" style={{ fontSize: 12, padding: '4px 10px' }} onClick={handleAddPaletteColor}>
                      ＋ Add Color
                    </button>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {formPalette.map((color, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface-subtle)', padding: '6px 10px', borderRadius: 6 }}>
                      <input
                        type="color"
                        value={color.hex.startsWith('#') && color.hex.length === 7 ? color.hex : '#ffffff'}
                        onChange={(e) => handleUpdatePaletteColor(idx, e.target.value, color.role)}
                        style={{ width: 36, height: 32, border: 'none', cursor: 'pointer', background: 'transparent' }}
                      />
                      <input
                        type="text"
                        value={color.hex}
                        onChange={(e) => handleUpdatePaletteColor(idx, e.target.value, color.role)}
                        placeholder="#1F2A44"
                        style={{ width: 95, fontFamily: 'monospace', fontSize: 13 }}
                      />
                      <input
                        type="text"
                        value={color.role}
                        onChange={(e) => handleUpdatePaletteColor(idx, color.hex, e.target.value)}
                        placeholder="Color role (e.g. dusk blue, shadow side of forms)"
                        style={{ flex: 1, fontSize: 13 }}
                      />
                      {formPalette.length > 3 ? (
                        <button
                          type="button"
                          className="button"
                          style={{ padding: '4px 8px', color: '#b5654f' }}
                          onClick={() => handleRemovePaletteColor(idx)}
                          title="Remove color"
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </fieldset>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="form-light">Lighting</label>
                  <input id="form-light" value={formLight} onChange={(e) => setFormLight(e.target.value)} placeholder="Stylized light with soft bloom" disabled={isSaving} required />
                </div>
                <div className="field">
                  <label htmlFor="form-texture">Texture / Grain</label>
                  <input id="form-texture" value={formTexture} onChange={(e) => setFormTexture(e.target.value)} placeholder="Clean, flat color fills with subtle grain" disabled={isSaving} required />
                </div>
                <div className="field">
                  <label htmlFor="form-contrast">Contrast</label>
                  <input id="form-contrast" value={formContrast} onChange={(e) => setFormContrast(e.target.value)} placeholder="Medium-high contrast" disabled={isSaving} required />
                </div>
                <div className="field">
                  <label htmlFor="form-shading">Shading</label>
                  <input id="form-shading" value={formShading} onChange={(e) => setFormShading(e.target.value)} placeholder="Cel shading with sharp highlights" disabled={isSaving} required />
                </div>
              </div>

              {/* Motion hints */}
              <fieldset className="field" style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <legend style={{ fontWeight: 600 }}>Motion Hints ({formMotionHints.length} Hints)</legend>
                  <button type="button" className="button" style={{ fontSize: 12, padding: '4px 10px' }} onClick={handleAddMotionHint}>
                    ＋ Add Hint
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {formMotionHints.map((hint, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="text"
                        value={hint}
                        onChange={(e) => handleUpdateMotionHint(idx, e.target.value)}
                        placeholder="e.g. rain streaks falling steadily past the window"
                        style={{ flex: 1, fontSize: 13 }}
                      />
                      <button type="button" className="button" style={{ padding: '4px 8px', color: '#b5654f' }} onClick={() => handleRemoveMotionHint(idx)}>
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>

              {/* Music Profile DNA (Optional) */}
              <details style={{ marginTop: 14, background: 'var(--bg-surface-subtle)', padding: '12px 14px', borderRadius: 8 }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer' }}>🎵 Optional Music DNA Integration</summary>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 12 }}>
                  <div className="field">
                    <label>Genre</label>
                    <input value={formMusicGenre} onChange={(e) => setFormMusicGenre(e.target.value)} placeholder="lofi hip hop, instrumental downtempo" />
                  </div>
                  <div className="field">
                    <label>Aesthetic Atmosphere</label>
                    <input value={formMusicAesthetic} onChange={(e) => setFormMusicAesthetic(e.target.value)} placeholder="late night city apartment, nostalgic, rain" />
                  </div>
                  <div className="field">
                    <label>Production Tags</label>
                    <input value={formMusicProduction} onChange={(e) => setFormMusicProduction(e.target.value)} placeholder="warm tape saturation, vinyl crackle" />
                  </div>
                  <div className="field">
                    <label>Instruments</label>
                    <input value={formMusicInstruments} onChange={(e) => setFormMusicInstruments(e.target.value)} placeholder="dusty Rhodes piano, upright bass" />
                  </div>
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label>Exclude / Negative Tags</label>
                    <input value={formMusicExclude} onChange={(e) => setFormMusicExclude(e.target.value)} placeholder="vocals, lyrics, EDM drops, heavy distortion" />
                  </div>
                </div>
              </details>

              <div className="form-actions" style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <button className="button button-primary" type="submit" disabled={isSaving}>
                  {isSaving ? 'Saving Image Style...' : '✨ Create Image Style'}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}

      {/* EDIT FORM */}
      {editingStyleName ? (
        <div className="panel" style={{ marginBottom: 28, borderLeft: '4px solid var(--secondary)' }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>✏️ Edit Image Style: <code>{editingStyleName}</code></h2>
              <p className="field-hint" style={{ margin: '4px 0 0' }}>
                Update the visual parameters, color palette and motion hints.
              </p>
            </div>
            <button
              type="button"
              className="toast-close"
              style={{ fontSize: 22, width: 32, height: 32 }}
              onClick={() => closeForm(true)}
              title="Kapat (Taslak korunur)"
              aria-label="Kapat"
            >
              ×
            </button>
          </header>

          {/* Restored Draft Alert for Edit */}
          {restoredDraftTime ? (
            <div
              className="notice"
              style={{
                borderColor: '#e5dccb',
                background: '#faf7f0',
                color: '#5c523b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 16,
              }}
            >
              <div>
                <strong>📝 Düzenleme taslağı yüklendi</strong> <span className="muted">({restoredDraftTime})</span>
              </div>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, padding: '2px 8px' }}
                onClick={() => clearEditDraft(editingStyleName)}
              >
                🔄 Orijinale Dön
              </button>
            </div>
          ) : null}

          {formError ? (
            <div className="state-card" role="alert" style={{ borderColor: '#b5654f', color: '#97432c', marginBottom: 16 }}>
              <strong>{formError}</strong>
              {formProblems.length > 0 ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {formProblems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <form onSubmit={handleSaveManualStyle} noValidate>
            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="edit-name">Image Style Name (ID)</label>
              <input
                id="edit-name"
                value={formName}
                placeholder="e.g. anime-cozy-dusk"
                onChange={(event) => setFormName(event.target.value)}
                autoComplete="off"
                disabled={isSaving}
                required
              />
              <p className="field-hint">
                Benzersiz stil kimliği (ID). Küçük harf, rakam ve tire kullanın (ör. 111 veya cozy-realistic).
              </p>
            </div>

            <fieldset className="field" style={{ marginBottom: 16 }}>
              <legend style={{ fontWeight: 600 }}>Reference Images ({editReferences.length} Görsel)</legend>
              <ReferencePicker
                items={editReferences}
                onChange={setEditReferences}
                emptyLabel={`Henüz referans görseli eklenmedi (${IMAGE_FORMATS_LABEL})`}
                buttonLabel="＋ Referans Görseli Ekle"
              />
              {editReferences.length > 0 ? (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    className="button button-primary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                    onClick={handleRegenerateFromReferences}
                    disabled={isRegenerating || isSaving}
                    title="Referans görsellerden Gemini AI ile tüm prompt alanlarını yeniden üret"
                  >
                    {isRegenerating ? '✨ Gemini Analiz Ediyor...' : '🤖 Referanslara Göre Prompt Güncelle'}
                  </button>
                  {isRegenerating ? (
                    <span className="field-hint" style={{ margin: 0 }}>
                      Bu işlem birkaç saniye sürebilir...
                    </span>
                  ) : (
                    <span className="field-hint" style={{ margin: 0 }}>
                      Tüm stil alanları (Medium, Lines, Palette, vb.) referans görsellerden otomatik güncellenecek.
                    </span>
                  )}
                </div>
              ) : null}
            </fieldset>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              <div className="field">
                <label htmlFor="edit-medium">Medium / Technique</label>
                <textarea
                  id="edit-medium"
                  rows={2}
                  value={formMedium}
                  onChange={(e) => setFormMedium(e.target.value)}
                  disabled={isSaving}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="edit-lines">Line Quality</label>
                <textarea
                  id="edit-lines"
                  rows={2}
                  value={formLines}
                  onChange={(e) => setFormLines(e.target.value)}
                  disabled={isSaving}
                  required
                />
              </div>
            </div>

            {/* Palette Builder */}
            <fieldset className="field" style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <legend style={{ fontWeight: 600 }}>Color Palette ({formPalette.length} Colors)</legend>
                {formPalette.length < 8 ? (
                  <button type="button" className="button" style={{ fontSize: 12, padding: '4px 10px' }} onClick={handleAddPaletteColor}>
                    ＋ Add Color
                  </button>
                ) : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {formPalette.map((color, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface-subtle)', padding: '6px 10px', borderRadius: 6 }}>
                    <input
                      type="color"
                      value={color.hex.startsWith('#') && color.hex.length === 7 ? color.hex : '#ffffff'}
                      onChange={(e) => handleUpdatePaletteColor(idx, e.target.value, color.role)}
                      style={{ width: 36, height: 32, border: 'none', cursor: 'pointer', background: 'transparent' }}
                    />
                    <input
                      type="text"
                      value={color.hex}
                      onChange={(e) => handleUpdatePaletteColor(idx, e.target.value, color.role)}
                      placeholder="#1F2A44"
                      style={{ width: 95, fontFamily: 'monospace', fontSize: 13 }}
                    />
                    <input
                      type="text"
                      value={color.role}
                      onChange={(e) => handleUpdatePaletteColor(idx, color.hex, e.target.value)}
                      placeholder="Color role"
                      style={{ flex: 1, fontSize: 13 }}
                    />
                    {formPalette.length > 3 ? (
                      <button
                        type="button"
                        className="button"
                        style={{ padding: '4px 8px', color: '#b5654f' }}
                        onClick={() => handleRemovePaletteColor(idx)}
                        title="Remove color"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </fieldset>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 10 }}>
              <div className="field">
                <label htmlFor="edit-light">Lighting</label>
                <input id="edit-light" value={formLight} onChange={(e) => setFormLight(e.target.value)} disabled={isSaving} required />
              </div>
              <div className="field">
                <label htmlFor="edit-texture">Texture / Grain</label>
                <input id="edit-texture" value={formTexture} onChange={(e) => setFormTexture(e.target.value)} disabled={isSaving} required />
              </div>
              <div className="field">
                <label htmlFor="edit-contrast">Contrast</label>
                <input id="edit-contrast" value={formContrast} onChange={(e) => setFormContrast(e.target.value)} disabled={isSaving} required />
              </div>
              <div className="field">
                <label htmlFor="edit-shading">Shading</label>
                <input id="edit-shading" value={formShading} onChange={(e) => setFormShading(e.target.value)} disabled={isSaving} required />
              </div>
            </div>

            {/* Motion hints */}
            <fieldset className="field" style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <legend style={{ fontWeight: 600 }}>Motion Hints ({formMotionHints.length} Hints)</legend>
                <button type="button" className="button" style={{ fontSize: 12, padding: '4px 10px' }} onClick={handleAddMotionHint}>
                  ＋ Add Hint
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {formMotionHints.map((hint, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      value={hint}
                      onChange={(e) => handleUpdateMotionHint(idx, e.target.value)}
                      placeholder="e.g. steam rising in simple stylized wisps"
                      style={{ flex: 1, fontSize: 13 }}
                    />
                    <button type="button" className="button" style={{ padding: '4px 8px', color: '#b5654f' }} onClick={() => handleRemoveMotionHint(idx)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </fieldset>

            {/* Music Profile */}
            <details style={{ marginTop: 14, background: 'var(--bg-surface-subtle)', padding: '12px 14px', borderRadius: 8 }}>
              <summary style={{ fontWeight: 600, cursor: 'pointer' }}>🎵 Optional Music DNA Integration</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 12 }}>
                <div className="field">
                  <label>Genre</label>
                  <input value={formMusicGenre} onChange={(e) => setFormMusicGenre(e.target.value)} placeholder="lofi hip hop, chillhop" />
                </div>
                <div className="field">
                  <label>Aesthetic Atmosphere</label>
                  <input value={formMusicAesthetic} onChange={(e) => setFormMusicAesthetic(e.target.value)} placeholder="late night city apartment, nostalgic, rain" />
                </div>
                <div className="field">
                  <label>Production Tags</label>
                  <input value={formMusicProduction} onChange={(e) => setFormMusicProduction(e.target.value)} placeholder="warm tape saturation, vinyl crackle" />
                </div>
                <div className="field">
                  <label>Instruments</label>
                  <input value={formMusicInstruments} onChange={(e) => setFormMusicInstruments(e.target.value)} placeholder="dusty Rhodes piano, upright bass" />
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Exclude / Negative Tags</label>
                  <input value={formMusicExclude} onChange={(e) => setFormMusicExclude(e.target.value)} placeholder="vocals, lyrics, EDM drops, heavy distortion" />
                </div>
              </div>
            </details>

            <div className="form-actions" style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
              <button className="button button-primary" type="submit" disabled={isSaving}>
                {isSaving ? 'Saving Changes...' : '💾 Save Changes'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* DELETE CONFIRMATION DIALOG */}
      {deletingStyle ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div className="panel" style={{ maxWidth: 450, width: '100%', borderTop: '4px solid #a63a2b' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 18, color: '#a63a2b' }}>Delete Image Style</h3>
            <p style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
              Are you sure you want to delete the image style <strong>"{deletingStyle}"</strong>? This will remove the style file and its reference image from your library.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="button" type="button" onClick={() => setDeletingStyle(null)} disabled={isSaving}>
                Cancel
              </button>
              <button
                className="button button-primary"
                style={{ background: '#a63a2b', borderColor: '#a63a2b' }}
                type="button"
                onClick={handleDeleteStyle}
                disabled={isSaving}
              >
                {isSaving ? 'Deleting...' : '🗑️ Delete Style'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* SEARCH AND TOOLBAR */}
      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Search image styles"
          aria-label="Search image styles"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="muted">
            {loadState === 'loading' ? 'Loading image styles...' : `${visibleStyles.length} image styles`}
          </span>
          <LayoutSwitcher
            value={layoutCols}
            onChange={setLayoutCols}
            storageKey="lofi-layout-styles"
            ariaLabel="Görsel stil görünüm düzeni"
          />
        </div>
      </div>

      {styles.length === 0 && !isDraftVisible ? (
        <EmptyState title="No image styles yet." />
      ) : visibleStyles.length === 0 && !isDraftVisible ? (
        <EmptyState
          title="No image styles match your search."
          action={
            <button className="button" type="button" onClick={() => setQuery('')}>
              Clear search
            </button>
          }
        />
      ) : (
        <div className={`card-grid-layout cols-${layoutCols}`}>
          {isDraftVisible && savedCreateDraft ? (
            <div
              className="library-card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: 'var(--primary, #c97a63)',
                borderStyle: 'dashed',
                borderWidth: 2,
                background: 'rgba(201, 122, 99, 0.04)',
              }}
              onClick={openCreateForm}
            >
              <div
                className="swatch"
                aria-hidden="true"
                style={{
                  display: 'flex',
                  height: 28,
                  background: 'var(--bg-surface-subtle, #f0ede6)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {Array.isArray(savedCreateDraft.formPalette) && savedCreateDraft.formPalette.length > 0 ? (
                  savedCreateDraft.formPalette.map((p, idx) => (
                    <span key={idx} style={{ background: p.hex, flex: 1, height: '100%' }} />
                  ))
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--primary, #c97a63)', fontWeight: 600 }}>
                    📝 TASLAK / DRAFT
                  </span>
                )}
              </div>
              <div className="library-card-body" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div
                  className="library-card-title"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                >
                  <strong style={{ color: 'var(--primary, #c97a63)' }}>
                    [Taslak] {savedCreateDraft.aiName || savedCreateDraft.formName || 'İsimsiz Stil Taslağı'}
                  </strong>
                  <StatusBadge status="warning" label="Taslak" />
                </div>
                <code>{slugify(savedCreateDraft.aiName || savedCreateDraft.formName || 'style-draft')}</code>
                <p style={{ margin: '8px 0', flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>
                  {savedCreateDraft.aiConcept || savedCreateDraft.formMedium || 'Kaydedilmiş stil taslağı.'}
                </p>
                {savedCreateDraft.aiReferences && savedCreateDraft.aiReferences.length > 0 ? (
                  <p className="muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
                    🖼️ <strong>{savedCreateDraft.aiReferences.length} Referans Görsel:</strong>{' '}
                    {savedCreateDraft.aiReferences.map((r) => r.name).join(', ')}
                  </p>
                ) : null}
                {savedCreateDraft.savedAt ? (
                  <p className="muted" style={{ fontSize: 11, margin: '2px 0 8px' }}>
                    🕒 Kaydedildi: {savedCreateDraft.savedAt}
                  </p>
                ) : null}

                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    marginTop: 'auto',
                    paddingTop: 10,
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="button button-primary"
                    style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={openCreateForm}
                  >
                    ✨ Taslağı Aç & Üret
                  </button>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12, padding: '4px 8px', color: '#a63a2b' }}
                    onClick={clearCreateDraft}
                  >
                    🗑️ Taslağı Sil
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {visibleStyles.map((style) => {
            const isSelected = style.id === selectedId;
            const isCustomGenerated = style.id === 'custom-generated';

            return (
              <div
                key={style.id}
                className={isSelected ? 'library-card selected' : 'library-card'}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  textAlign: 'left',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  padding: 0,
                }}
                onClick={() => setSelectedId(isSelected ? null : style.id)}
              >
                {/* Multi-reference Image / Visual Header */}
                <StyleCardHeader style={style} isCustomGenerated={isCustomGenerated} />
                <div className="library-card-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 14px' }}>
                  <div className="library-card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{style.name}</strong>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {isSelected ? <StatusBadge status="selected" label="Selected" /> : null}
                      {isCustomGenerated ? (
                        <StatusBadge status="processing" label="Custom Multi-Ref" />
                      ) : null}
                    </div>
                  </div>
                  <code>{style.id}</code>
                  <p style={{ margin: '8px 0', flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{style.description}</p>

                  {/* Actions footer on each card */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginTop: 'auto',
                      paddingTop: 10,
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!isCustomGenerated ? (
                      <>
                        <button
                          type="button"
                          className="button"
                          style={{ fontSize: 12, padding: '4px 8px' }}
                          onClick={() => openEditForm(style.id)}
                        >
                          ✏️ Edit
                        </button>
                        <button
                          type="button"
                          className="button"
                          style={{ fontSize: 12, padding: '4px 8px', color: '#a63a2b' }}
                          onClick={() => setDeletingStyle(style.id)}
                        >
                          🗑️ Delete
                        </button>
                      </>
                    ) : null}
                    {onUseStyle ? (
                      <button
                        type="button"
                        className="button button-primary"
                        style={{ fontSize: 12, padding: '4px 10px', marginLeft: 'auto' }}
                        onClick={() => onUseStyle(style.id)}
                      >
                        Use in Project →
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
