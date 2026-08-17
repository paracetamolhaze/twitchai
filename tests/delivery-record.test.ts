import { describe, expect, it } from 'vitest';
import { DeliveryRecord } from '../src/twitch/delivery-record';

describe('DeliveryRecord', () => {
  it('learns which accounts the channel shows from traffic that was being sent anyway', () => {
    // The active check this replaces had all thirty accounts post a bare number two seconds apart,
    // and measuring cost the thing measured: nineteen delivered at 11:55 on 17 August, the check
    // ran, and by 12:13 the same accounts were down to four.
    const record = new DeliveryRecord({ observesChat: () => true, now: () => 1_000 });
    for (const username of ['gigantiuz', 'alexmadkid']) record.recordSent(username);
    record.recordShown('gigantiuz');
    record.recordHidden('alexmadkid');

    const snapshot = record.snapshot();
    expect(snapshot.observing).toBe(true);
    expect(snapshot.accounts).toEqual([
      { username: 'alexmadkid', sent: 1, shown: 0, hidden: 1, refused: 0, lastHiddenAt: 1_000 },
      { username: 'gigantiuz', sent: 1, shown: 1, hidden: 0, refused: 0, lastShownAt: 1_000 },
    ]);
  });

  it('separates a refusal Twitch explained from a message it dropped in silence', () => {
    // Twitch acknowledges nothing on send, so silence and a stated refusal are different findings:
    // one is a suppressed account, the other is a channel rule anyone can fix.
    const record = new DeliveryRecord();
    record.recordSent('mavinoko');
    record.recordHidden('mavinoko', 'msg_followersonly');
    const [entry] = record.snapshot().accounts;
    expect(entry).toMatchObject({ username: 'mavinoko', hidden: 0, refused: 1, lastReason: 'msg_followersonly' });
  });

  it('puts the accounts worth knowing about first', () => {
    const record = new DeliveryRecord();
    for (const username of ['healthy', 'silenced', 'mixed']) record.recordSent(username);
    record.recordShown('healthy');
    record.recordShown('healthy');
    record.recordHidden('silenced');
    record.recordHidden('silenced');
    record.recordShown('mixed');
    record.recordHidden('mixed');
    expect(record.snapshot().accounts.map((entry) => entry.username)).toEqual(['silenced', 'mixed', 'healthy']);
  });

  it('says plainly that nothing can be judged while no account is reading chat', () => {
    // Delivery is decided by whether a message came back through the reader. Without one, every
    // account would otherwise read as silenced.
    const record = new DeliveryRecord({ observesChat: () => false });
    expect(record.snapshot().observing).toBe(false);
  });
});
