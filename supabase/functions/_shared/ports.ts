import type { BotSettings, PostRaceBriefing, Session, User, UserStatus } from './domain.ts';

export interface CountryOption {
  text: string;
  callbackData: string;
}

export interface UserRepository {
  getUser(userId: number): Promise<User | null>;
  saveUser(user: User): Promise<void>;
  updateUserStatus(userId: number, status: UserStatus): Promise<void>;
  updateUserTimezone(userId: number, timezone: string): Promise<void>;
  listActiveUsers(): Promise<User[]>;
}

export interface SettingsRepository {
  getValue(key: string): Promise<string>;
  getBotSettings(): Promise<BotSettings>;
}

export interface MessagingService {
  sendMessage(chatId: number, text: string): Promise<void>;
  sendCountryOptions(
    chatId: number,
    text: string,
    options: CountryOption[][],
  ): Promise<void>;
  sendSubscribePrompt(
    chatId: number,
    text: string,
    buttonText: string,
    callbackData: string,
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

export interface SessionProvider {
  getNextSessionAfter(when: Date): Promise<Session | null>;
  getNextRaceAfter(when: Date): Promise<Session | null>;
  getPostRaceBriefing(when: Date): Promise<PostRaceBriefing | null>;
  getSourceName(): string;
}
