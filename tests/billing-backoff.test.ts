import { describe, expect, it } from 'vitest';
import { BillingBackoff, isBillingFailure } from '../src/billing-backoff';

describe('billing circuit', () => {
  it('recognizes balance failures without treating rate limits as depleted money', () => {
    expect(isBillingFailure(new Error('402 Prompt tokens limit exceeded'))).toBe(true);
    expect(isBillingFailure(new Error('429 rate limit'))).toBe(false);
  });
  it('does not let an older successful request erase a newer billing failure', () => {
    const circuit = new BillingBackoff();
    const revision = circuit.revision;
    circuit.failure(new Error('402 balance'));
    circuit.success(revision);
    expect(circuit.acquire()).toBe(false);
  });
  it('allows one recovery probe, backs off again on failure and resumes on success', () => {
    let now = 1000;
    const circuit = new BillingBackoff(() => now);
    expect(circuit.acquire()).toBe(true);
    circuit.failure(new Error('402 balance'));
    expect(circuit.acquire()).toBe(false);
    now += 300000;
    expect(circuit.acquire()).toBe(true);
    expect(circuit.acquire()).toBe(false);
    circuit.failure(new Error('network timeout'));
    expect(circuit.acquire()).toBe(false);
    now += 300000;
    expect(circuit.acquire()).toBe(true);
    circuit.success();
    expect(circuit.acquire()).toBe(true);
  });
});
