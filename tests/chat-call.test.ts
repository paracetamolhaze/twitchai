import { describe, expect, it } from 'vitest';
import { crowdResponseCeiling, detectChatCall, isConstrainedCall, isConstrainedReply } from '../src/stream-brain/chat-call';

describe('chat call detection — explicit invitations to the room', () => {
  it('recognises the production hearing check verbatim', () => {
    const speech = 'S: Так, у нас маленький битрейт. Я так понимаю, это в целом интернет сейчас плохой? '
      + 'Скажите, пожалуйста, меня слышно? Если да, киньте плюсик в чат. Если нет, киньте минус.';
    expect(detectChatCall(speech)).toBe('binary_check');
  });

  it('recognises the production room-tour invitation with no question mark and no «чат»', () => {
    const speech = 'S: Если вам также понравилось, как я это всё рассказала, показала, тоже расскажите, '
      + 'что вам было полезным, ценным, что вам вообще понравилось';
    expect(detectChatCall(speech)).toBe('open_feedback');
  });

  it('classifies the brief\'s example invitations', () => {
    expect(detectChatCall('чат, меня слышно?')).toBe('binary_check');
    expect(detectChatCall('киньте плюс')).toBe('show_of_hands');
    expect(detectChatCall('как вам рум-тур?')).toBe('request_for_opinion');
    expect(detectChatCall('напишите что думаете')).toBe('open_feedback');
    expect(detectChatCall('кто ещё здесь?')).toBe('show_of_hands');
    expect(detectChatCall('у кого так было?')).toBe('show_of_hands');
    expect(detectChatCall('вам нравится?')).toBe('request_for_opinion');
    expect(detectChatCall('что больше всего понравилось?')).toBe('request_for_opinion');
    expect(detectChatCall('ставим + если идем')).toBe('show_of_hands');
    expect(detectChatCall('выберите один или два')).toBe('poll');
    expect(detectChatCall('скажите честно')).toBe('request_for_opinion');
    expect(detectChatCall('кто за?')).toBe('show_of_hands');
  });

  it('leaves ordinary moments alone — no call detected', () => {
    expect(detectChatCall('поднимаемся на второй этаж')).toBeUndefined();
    expect(detectChatCall('он на СФе?')).toBeUndefined();
    expect(detectChatCall('а сколько тогда')).toBeUndefined();
    expect(detectChatCall('сутки стоят 1500 долларов')).toBeUndefined();
    expect(detectChatCall('смотрите какой дом огромный')).toBeUndefined();
    expect(detectChatCall('мы ставим стол в углу')).toBeUndefined();
  });

  it('separates constrained calls from open ones', () => {
    expect(isConstrainedCall('binary_check')).toBe(true);
    expect(isConstrainedCall('show_of_hands')).toBe(true);
    expect(isConstrainedCall('open_feedback')).toBe(false);
    expect(isConstrainedCall('request_for_opinion')).toBe(false);
  });

  it('knows what a constrained reply looks like', () => {
    for (const reply of ['+', '-', '+ слышно', 'да', 'слышно норм', '2', 'плюс']) {
      expect(isConstrainedReply(reply), reply).toBe(true);
    }
    for (const reply of ['дом огромный конечно', 'отличный рум-тур получился!', 'да там вообще жесть была']) {
      expect(isConstrainedReply(reply), reply).toBe(false);
    }
  });

  it('bands are ceilings that respect a flooding human chat', () => {
    expect(crowdResponseCeiling('binary_check', 0)).toBe(6);
    expect(crowdResponseCeiling('open_feedback', 0)).toBe(4);
    expect(crowdResponseCeiling('general_question', 0)).toBe(3);
    expect(crowdResponseCeiling('binary_check', 8)).toBe(2);
  });
});
