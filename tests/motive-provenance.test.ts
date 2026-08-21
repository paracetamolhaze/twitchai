import { describe, expect, it } from 'vitest';
import { emptyProvenancePools, ProvenancePools, validateMotiveProvenance } from '../src/reaction/motive-provenance';
import { emptySuppliedSources } from '../src/personas/persona-mind';

function pools(overrides: Partial<ProvenancePools> = {}): ProvenancePools {
  return { ...emptyProvenancePools(), ...overrides };
}

function mindWith(overrides: Partial<ReturnType<typeof emptySuppliedSources>>) {
  return { ...emptySuppliedSources(), ...overrides };
}

describe('motive provenance validation — fixture B: the honest claim', () => {
  it('confirms a persistent source whose ref matches the supplied pool', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'curiosity', sourceRef: 'цены на аренду', message: 'а сколько выходит в месяц?' },
      pools({ mind: mindWith({ curiosity: ['цены на аренду жилья в Шанхае — сколько стоит месяц'] }) }),
    );
    expect(verdict).toEqual({ sourceValidated: true, validatedSourceType: 'curiosity', validationReason: 'confirmed' });
  });

  it('confirms across scripts via the shared topic yardstick', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'expertise', sourceRef: 'доту знает', message: 'тут таймингом решается' },
      pools({ expertise: ['Dota 2', 'киберспорт'] }),
    );
    expect(verdict.sourceValidated).toBe(true);
  });

  it('accepts a category claim without a ref when that category was actually supplied', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'current_life', message: 'у самого сейчас переезд, понимаю' },
      pools({ mind: mindWith({ current_life: ['собирает переезд в другой город'] }) }),
    );
    expect(verdict).toEqual({ sourceValidated: true, validatedSourceType: 'current_life', validationReason: 'confirmed' });
  });
});

describe('fixture C: the fabricated claim', () => {
  it('rejects a ref that matches nothing anywhere in the supplied state', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'memory', sourceRef: 'вспомнил случай с сервером', message: 'у меня так сервер лёг однажды' },
      pools({ mind: mindWith({ curiosity: ['цены на аренду'] }), memories: ['любит рыбалку по выходным'] }),
    );
    expect(verdict).toEqual({ sourceValidated: false, validationReason: 'ref_matches_nothing' });
  });

  it('rejects a category claim when nothing of that category was supplied at all', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'knowledge_gap', message: 'а как это вообще работает?' },
      pools(),
    );
    expect(verdict).toEqual({ sourceValidated: false, validationReason: 'no_source_supplied' });
  });
});

describe('fixture D: the mislabeled but real claim', () => {
  it('downgrades to the category where the reference actually matched', () => {
    // The model called it a knowledge_gap; the reference is really a current_life concern.
    const verdict = validateMotiveProvenance(
      { sourceType: 'knowledge_gap', sourceRef: 'переезд в Шанхай', message: 'сам туда собираюсь, что по ценам?' },
      pools({ mind: mindWith({ current_life: ['готовит переезд в Шанхай этой осенью'] }) }),
    );
    expect(verdict).toEqual({
      sourceValidated: true, validatedSourceType: 'current_life', validationReason: 'category_corrected',
    });
  });
});

describe('structural sources', () => {
  it('event_emotion needs no archive but is not personal', () => {
    const verdict = validateMotiveProvenance(
      { sourceType: 'event_emotion', message: 'ахахах ну и момент' }, pools(),
    );
    expect(verdict.sourceValidated).toBe(true);
    expect(verdict.validationReason).toBe('not_personal');
  });

  it('none is a valid honest answer, kept apart from the personal bucket', () => {
    const verdict = validateMotiveProvenance({ sourceType: 'none', message: 'жестко' }, pools());
    expect(verdict.sourceValidated).toBe(true);
    expect(verdict.validationReason).toBe('not_personal');
  });

  it('a chat reply validates only when chat was actually in the payload', () => {
    expect(validateMotiveProvenance(
      { sourceType: 'chat', message: 'да тоже так думаю' }, pools({ hadRecentChat: true }),
    ).sourceValidated).toBe(true);
    expect(validateMotiveProvenance(
      { sourceType: 'chat', message: 'да тоже так думаю' }, pools({ hadRecentChat: false }),
    )).toEqual({ sourceValidated: false, validationReason: 'chat_not_supplied' });
  });

  it('a missing sourceType is unreported, never invented', () => {
    expect(validateMotiveProvenance({ message: 'ну и ну' }, pools()))
      .toEqual({ sourceValidated: false, validationReason: 'unreported' });
  });
});
