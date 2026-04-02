export const SUBSCRIBE_BUTTON_TEXT = '🔔 Activar alertas';
export const SUBSCRIBE_CALLBACK_DATA = 'subscribe_cta';

export function extractCommand(text: string | null | undefined): string | null {
  if (text == null) {
    return null;
  }

  const [firstToken] = text.trim().split(/\s+/, 1);
  if (!firstToken) {
    return null;
  }

  if (firstToken.includes('@')) {
    return firstToken.split('@', 1)[0] ?? null;
  }

  return firstToken;
}

export class RecentUpdateRegistry {
  private readonly seen = new Set<number>();
  private readonly order: number[] = [];

  constructor(private readonly capacity = 1000) {}

  markSeen(updateId: number): boolean {
    if (this.seen.has(updateId)) {
      return false;
    }

    this.seen.add(updateId);
    this.order.push(updateId);

    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }

    return true;
  }
}

