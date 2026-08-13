import { Logger } from '../logger';
import { ReactionMemory } from '../learning/reaction-memory';
import { BotHistory } from '../personas/bot-history';
import { ResponseProvider } from '../response/response-provider';
import { ContextStore } from '../stream-brain/context-store';
import { StreamEvent } from '../stream-brain/types';
import { UsageTracker } from '../usage/usage-tracker';
import { ReactionDecisionEngine } from './reaction-decision-engine';
import { PlannedReaction, ReactionBotCandidate } from './types';

export interface ReactionSender {
  send(username: string, message: string): Promise<boolean>;
}

export interface ReactionCoordinatorOptions {
  decision: ReactionDecisionEngine;
  provider: ResponseProvider;
  sender: ReactionSender;
  history: BotHistory;
  memory: ReactionMemory;
  contextStore: ContextStore;
  usage: UsageTracker;
  logger: Logger;
  retrievalLimit: number;
  candidates: () => ReactionBotCandidate[];
}

export class ReactionCoordinator {
  private readonly logger: Logger;
  private readonly timers = new Map<NodeJS.Timeout, PlannedReaction>();
  private readonly pendingBots = new Set<string>();
  private stopped = false;

  constructor(private readonly options: ReactionCoordinatorOptions) {
    this.logger = options.logger.child('DECISION');
  }

  handle(event: StreamEvent): void {
    if (this.stopped) return;
    const snapshot = this.options.contextStore.snapshot();
    this.options.memory.recordEvent(event, snapshot);
    const decided = this.options.decision.decide(event, this.options.candidates());
    const plans = decided.filter((plan) => !this.pendingBots.has(plan.bot.username));
    for (const rejected of decided.filter((plan) => !plans.includes(plan))) {
      this.options.decision.releaseReservation(rejected.reservationId);
    }
    this.logger.info('Reaction decision', {
      eventId: event.id,
      importance: event.importance,
      bots: plans.map((plan) => plan.bot.username),
    });
    if (plans.length === 0) {
      this.options.usage.recordSkipped();
      return;
    }
    for (const plan of plans) {
      this.pendingBots.add(plan.bot.username);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.execute(plan).finally(() => this.pendingBots.delete(plan.bot.username));
      }, plan.delayMs);
      this.timers.set(timer, plan);
      this.logger.info('Bot reaction queued', { bot: plan.bot.username, delayMs: plan.delayMs, directMention: plan.directMention });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [timer, plan] of this.timers) {
      clearTimeout(timer);
      this.options.decision.releaseReservation(plan.reservationId);
    }
    this.timers.clear();
    this.pendingBots.clear();
  }

  private async execute(plan: PlannedReaction): Promise<void> {
    const { bot: plannedBot, event } = plan;
    try {
      const current = this.options.candidates().find((bot) => bot.username === plannedBot.username);
      if (!current?.enabled || current.connectionState !== 'CONNECTED' || !current.chatConnected) {
        this.options.usage.recordSkipped();
        return;
      }
      const context = this.options.contextStore.snapshot();
      const history = await this.options.history.recent(current.username);
      const examples = await this.options.memory.retrieve(event, context, this.options.retrievalLimit);
      let generated = await this.options.provider.generate({
        event, context, persona: current.persona, username: current.username, history, examples,
      });
      if (generated.kind === 'skip') {
        this.options.usage.recordSkipped();
        return;
      }
      if (await this.options.history.isDuplicate(current.username, generated.text)) {
        generated = await this.options.provider.generate({
          event, context, persona: current.persona, username: current.username, history, examples,
          retryReason: 'The first draft was too similar to recent messages. Use a different idea and wording, or <skip>.',
        });
      }
      if (generated.kind === 'skip' || await this.options.history.isDuplicate(current.username, generated.text)) {
        this.options.usage.recordSkipped();
        return;
      }
      const sent = await this.options.sender.send(current.username, generated.text);
      if (!sent) {
        this.options.usage.recordSkipped();
        return;
      }
      await this.options.history.add(current.username, generated.text, event.id);
      this.options.decision.recordSent(Date.now(), plan.reservationId);
      this.options.usage.recordGenerated();
      this.logger.info('Bot reaction sent', { bot: current.username, eventId: event.id, message: generated.text });
    } catch (cause) {
      this.options.usage.recordSkipped();
      this.logger.warn('Queued bot reaction failed', { bot: plannedBot.username, eventId: event.id, cause });
    } finally {
      this.options.decision.releaseReservation(plan.reservationId);
    }
  }
}
