import { describe, expect, it } from 'vitest';

import type { ProjectWorkflow, WorkflowStepInfo } from './types';
import { isStepReachable, nextStepId, previousStep, STEP_GUIDE, STEP_ORDER, stepGuide, viewWorkflow } from './workflow';

type Status = WorkflowStepInfo['status'];

/** Sunucunun 6 adımlı akışı; `statuses` sırayla project, video, music, order, build, publish. */
function serverWorkflow(statuses: Status[], current: ProjectWorkflow['current']): ProjectWorkflow {
  const ids = ['project', 'video', 'music', 'order', 'build', 'publish'] as const;
  const titles = ['Proje başlat', 'Video', 'Müzik', 'Sıralama', 'Montaj', 'Yayın'];
  return {
    current,
    currentTitle: titles[ids.indexOf(current as (typeof ids)[number])] ?? '',
    steps: ids.map((id, index) => ({
      id,
      number: index + 1,
      title: titles[index],
      kind: 'manual',
      optional: false,
      status: statuses[index],
      skipped: false,
    })),
  };
}

describe('viewWorkflow', () => {
  it('6 sunucu adımını 5 arayüz adımına indirir ve numaraları yeniden verir', () => {
    const view = viewWorkflow(serverWorkflow(['done', 'done', 'current', 'pending', 'pending', 'pending'], 'music'))!;
    expect(view.steps.map((step) => step.id)).toEqual(STEP_ORDER);
    expect(view.steps.map((step) => step.number)).toEqual([1, 2, 3, 4, 5]);
    expect(view.steps[2].title).toBe('Müzik ve sıralama');
  });

  it('birleşik adım yalnızca müzik VE sıralama bitince tamamlanır', () => {
    const status = (m: Status, o: Status) =>
      viewWorkflow(serverWorkflow(['done', 'done', m, o, 'pending', 'pending'], 'music'))!.steps[2].status;
    expect(status('done', 'done')).toBe('done');
    expect(status('done', 'current')).toBe('current');
    expect(status('current', 'pending')).toBe('current');
    expect(status('pending', 'pending')).toBe('pending');
  });

  it('sunucu "music" ya da "order" adımındayken arayüz birleşik adımı ve başlığını gösterir', () => {
    const onOrder = viewWorkflow(serverWorkflow(['done', 'done', 'done', 'current', 'pending', 'pending'], 'order'))!;
    expect(onOrder.current).toBe('music');
    expect(onOrder.currentTitle).toBe('Müzik ve sıralama');

    const onMusic = viewWorkflow(serverWorkflow(['done', 'done', 'current', 'pending', 'pending', 'pending'], 'music'))!;
    expect(onMusic.current).toBe('music');
    expect(onMusic.currentTitle).toBe('Müzik ve sıralama');
  });

  it('sonraki adımlar kayar: montaj 4, yayın 5', () => {
    const view = viewWorkflow(serverWorkflow(['done', 'done', 'done', 'done', 'current', 'pending'], 'build'))!;
    expect(view.current).toBe('build');
    expect(view.steps.find((step) => step.id === 'build')?.number).toBe(4);
    expect(view.steps.find((step) => step.id === 'publish')?.number).toBe(5);
  });

  it('music/order içermeyen akışı (Shorts) olduğu gibi bırakır', () => {
    const shorts: ProjectWorkflow = {
      current: 'clips',
      currentTitle: 'Kesitler',
      steps: [{ id: 'clips', number: 1, title: 'Kesitler', kind: 'manual', optional: false, status: 'current', skipped: false }],
    };
    expect(viewWorkflow(shorts)).toBe(shorts);
    expect(viewWorkflow(undefined)).toBeUndefined();
  });
});

describe('adım gezintisi (5 adım)', () => {
  it('müzikten sonra doğrudan montaj gelir', () => {
    expect(nextStepId('music')).toBe('build');
    expect(previousStep('build')).toBe('music');
  });

  it('yalnızca tamamlanmış adımlara ve ilk açık adıma gidilir', () => {
    const view = viewWorkflow(serverWorkflow(['done', 'done', 'done', 'current', 'pending', 'pending'], 'order'))!;
    expect(isStepReachable(view, 'music')).toBe(true);
    expect(isStepReachable(view, 'build')).toBe(false);
  });
});

describe('stepGuide', () => {
  it('Ambiance projesinde bugünkü rehber metni aynen gelir', () => {
    for (const id of STEP_ORDER) expect(stepGuide(id, false)).toBe(STEP_GUIDE[id]);
  });

  it('Pomodoro projesinde proje/video/müzik/montaj adımlarının metni değişir', () => {
    for (const id of ['project', 'video', 'music', 'build'] as const) {
      expect(stepGuide(id, true)).not.toBe(STEP_GUIDE[id]);
    }
    expect(stepGuide('video', true).lines.join(' ')).toMatch(/sekmelerden/i);
    expect(stepGuide('build', true).who).toBe('system');
  });

  it('metni değişmeyen adım (yayın) Pomodoro için de aynı kalır', () => {
    expect(stepGuide('publish', true)).toBe(STEP_GUIDE.publish);
  });
});
