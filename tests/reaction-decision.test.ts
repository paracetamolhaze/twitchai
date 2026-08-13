import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONAS } from '../src/personas/defaults';
import { ReactionDecisionEngine } from '../src/reaction/reaction-decision-engine';
import { ReactionBotCandidate } from '../src/reaction/types';
import { StreamEvent } from '../src/stream-brain/types';

const now = 1_700_000_000_000;
const event = (importance: number, directMentions: string[] = []): StreamEvent => ({
  id: `event-${importance}`,
  timestamp: now,
  type: 'fail',
  summary: 'streamer missed an important ultimate',
  importance,
  confidence: 0.95,
  source: 'gemini-live',
  directMentions,
});
const bot = (username: string, index = 0): ReactionBotCandidate => ({
  username,
  persona: { ...DEFAULT_PERSONAS[index % DEFAULT_PERSONAS.length]!, reactionProbability: 1, minimumIntervalMs: 30_000 },
  enabled: true,
  connectionState: 'CONNECTED',
  chatConnected: true,
});
const engine = (limit = 18) => new ReactionDecisionEngine({
  eventThreshold: 0.45,
  minimumDelayMs: 1_000,
  maximumDelayMs: 2_000,
  globalMessagesPer30Seconds: limit,
  random: () => 0,
  now: () => now,
});

describe('ReactionDecisionEngine', () => {
  it('skips low-importance events', () => {
    expect(engine().decide(event(0.15), [bot('one')])).toEqual([]);
  });

  it('selects several candidates for a strong event with staggered delays', () => {
    const plans = engine().decide(event(0.95), [bot('one'), bot('two', 1), bot('three', 2), bot('four', 3)]);
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((plan) => plan.delayMs)).size).toBe(3);
  });

  it('routes a direct mention exclusively to the addressed bot', () => {
    const plans = engine().decide(event(0.1, ['two']), [bot('one'), bot('two'), bot('three')]);
    expect(plans.map((plan) => plan.bot.username)).toEqual(['two']);
    expect(plans[0]?.directMention).toBe(true);
  });

  it('can prioritize every bot explicitly addressed in the same event', () => {
    const plans = engine().decide(event(0.1, ['one', 'three']), [bot('one'), bot('two'), bot('three')]);
    expect(plans.map((plan) => plan.bot.username)).toEqual(['one', 'three']);
  });

  it('honors the rolling global rate limit', () => {
    const decision = engine(2);
    decision.recordSent(now - 100);
    decision.recordSent(now - 50);
    expect(decision.decide(event(0.95), [bot('one'), bot('two')])).toEqual([]);
  });

  it('reserves rate-limit capacity for queued reactions and stays inside delay bounds', () => {
    const decision = engine(2);
    const plans = decision.decide(event(0.95), [bot('one'), bot('two'), bot('three')]);
    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => plan.delayMs >= 1_000 && plan.delayMs <= 2_000)).toBe(true);
    expect(decision.decide(event(0.95), [bot('four')])).toEqual([]);
  });
});
