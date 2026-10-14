import { Injectable, Logger, MessageEvent, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { filter, interval, map, merge, Observable, Subject, takeUntil } from 'rxjs';
import { DataSource } from 'typeorm';

export type StatusEventType = 'status.created' | 'status.classified' | 'status.deleted' | 'status.viewed';

interface Envelope {
  recipients: Set<string>;
  event: MessageEvent;
}

/**
 * In-process pub/sub for Server-Sent Events. A status event goes to its author
 * and to every user who has the author saved as a contact (i.e. whose feed shows it).
 *
 * Single-instance only: with several app instances, publish through Redis pub/sub instead.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<Envelope>();
  private readonly shutdown = new Subject<void>();

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Event stream for one user, with a heartbeat so proxies don't close idle connections. */
  stream(userId: string): Observable<MessageEvent> {
    const own = this.events.pipe(
      filter((e) => e.recipients.has(userId)),
      map((e) => e.event),
    );
    const heartbeat = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(own, heartbeat).pipe(takeUntil(this.shutdown));
  }

  /**
   * Ends every open stream. Otherwise the HTTP server waits forever for these
   * connections to close, and the app (or `nest start --watch`) never restarts.
   * Browsers reconnect on their own.
   */
  onModuleDestroy() {
    this.shutdown.next();
    this.shutdown.complete();
  }

  /** Publishes a status in the same shape as GET /statuses/feed rows. */
  async publishStatus(type: StatusEventType, statusId: string) {
    const rows = await this.db.query(
      `SELECT s.id, s.user_id AS "userId", u.name AS "authorName", s.text, s.bg_color AS "bgColor",
              s.tags, s.state, s.created_at AS "createdAt", s.expires_at AS "expiresAt"
         FROM statuses s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [statusId],
    );
    if (rows.length === 0) return;
    await this.publishToAudience(rows[0].userId, type, rows[0]);
  }

  /** Call before the row is deleted, or pass the author id you already have. */
  async publishDeleted(authorId: string, statusId: string) {
    await this.publishToAudience(authorId, 'status.deleted', { id: statusId });
  }

  /** Only the owner sees who viewed their status. */
  publishViewed(ownerId: string, data: { statusId: string; viewerId: string; viewerName: string }) {
    this.emit(new Set([ownerId]), 'status.viewed', data);
  }

  private async publishToAudience(authorId: string, type: StatusEventType, data: object) {
    try {
      const viewers: { user_id: string }[] = await this.db.query(
        `SELECT user_id FROM contacts WHERE contact_id = $1`,
        [authorId],
      );
      this.emit(new Set([authorId, ...viewers.map((v) => v.user_id)]), type, data);
    } catch (e) {
      // Realtime is best-effort; never fail the request or job because of it.
      this.logger.error(`Failed to publish ${type}: ${e}`);
    }
  }

  private emit(recipients: Set<string>, type: StatusEventType, data: object) {
    this.events.next({ recipients, event: { type, data } });
  }
}
