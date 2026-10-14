import { InjectQueue } from '@nestjs/bullmq';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { CLASSIFY_QUEUE, ClassifyJob } from '../classification/classification.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { Tag } from '../tagging/tag-store.service';
import { EXACT_WEIGHT, TaggingService, WeightedTag } from '../tagging/tagging.service';
import { CreateStatusDto } from './dto/create-status.dto';
import { FeedQueryDto } from './dto/feed-query.dto';
import { FeedFilter, SaveFilterDto } from './dto/feed-filter.dto';
import { Status } from './status.entity';

const STATUS_COLUMNS = `
  s.id, s.user_id AS "userId", u.name AS "authorName", s.text, s.bg_color AS "bgColor",
  s.tags, s.state, s.created_at AS "createdAt", s.expires_at AS "expiresAt"`;

// How many recent live statuses a newly learned tag is checked against.
const BACKFILL_LIMIT = 500;

@Injectable()
export class StatusesService {
  private readonly logger = new Logger(StatusesService.name);

  constructor(
    @InjectRepository(Status) private readonly repo: Repository<Status>,
    @InjectDataSource() private readonly db: DataSource,
    @InjectQueue(CLASSIFY_QUEUE) private readonly queue: Queue<ClassifyJob>,
    private readonly realtime: RealtimeService,
    private readonly tagging: TaggingService,
  ) {}

  async create(userId: string, dto: CreateStatusDto) {
    const status = await this.repo.save(
      this.repo.create({
        userId,
        text: dto.text,
        bgColor: dto.bgColor ?? '#075E54',
        tags: [],
        state: 'pending',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    );
    await this.queue.add('classify', { statusId: status.id }, { jobId: status.id });
    await this.realtime.publishStatus('status.created', status.id);
    return status;
  }

  async findOwn(userId: string, id: string) {
    const status = await this.repo.findOneBy({ id });
    if (!status) throw new NotFoundException();
    if (status.userId !== userId) throw new ForbiddenException();
    return status;
  }

  /** The viewer's own unexpired statuses with view counts. */
  mine(userId: string) {
    return this.db.query(
      `SELECT s.id, s.text, s.bg_color AS "bgColor", s.tags, s.state,
              s.created_at AS "createdAt", s.expires_at AS "expiresAt",
              (SELECT count(*)::int FROM status_views v WHERE v.status_id = s.id) AS "viewCount"
         FROM statuses s
        WHERE s.user_id = $1 AND s.expires_at > now()
        ORDER BY s.created_at DESC`,
      [userId],
    );
  }

  /** The viewer's saved feed filter, or the empty "All" filter if they never set one. */
  async getFilter(userId: string): Promise<FeedFilter> {
    const rows: FeedFilter[] = await this.db.query(
      `SELECT query, concepts, tags, match FROM feed_filters WHERE user_id = $1`,
      [userId],
    );
    const filter = rows[0] ?? { query: '', concepts: [], tags: [], match: 'any' };

    // Filters saved before weighted tags stored plain ids: resolve the search again, once.
    if (filter.concepts.some((c) => c.some((t) => typeof t === 'string'))) {
      const { concepts } = await this.tagging.match(filter.query);
      await this.db.query(`UPDATE feed_filters SET concepts = $2::jsonb WHERE user_id = $1`, [
        userId,
        JSON.stringify(concepts),
      ]);
      return { ...filter, concepts };
    }
    return filter;
  }

  /**
   * Saves the viewer's filter. A new search text is mapped onto tags once, here:
   * parts with no tag yet get a new tag (applied to existing statuses), the same
   * as when a status is posted. Fetching the feed then never calls OpenAI.
   */
  async saveFilter(userId: string, dto: SaveFilterDto) {
    const query = dto.query ?? '';
    const previous = await this.getFilter(userId);
    let concepts = previous.concepts;
    let createdTags: Tag[] = [];
    if (query !== previous.query) {
      ({ concepts, created: createdTags } = query ? await this.tagging.match(query) : { concepts: [], created: [] });
      if (createdTags.length) await this.applyNewTags(createdTags);
    }

    const filter: FeedFilter = { query, concepts, tags: dto.tags ?? [], match: dto.match ?? 'any' };
    await this.db.query(
      `INSERT INTO feed_filters (user_id, query, concepts, tags, match, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE
         SET query = $2, concepts = $3::jsonb, tags = $4, match = $5, updated_at = now()`,
      [userId, filter.query, JSON.stringify(filter.concepts), filter.tags, filter.match],
    );
    return { ...filter, createdTags };
  }

  /**
   * Statuses from the viewer's contacts, always filtered by their saved filter:
   * - search: an exact tag from every concept is required; related tags only
   *   raise the score. Results are ranked by `relevance` (0-1), then newest first.
   * - picked tags: any (or all) of them.
   * A search that matched no tags shows nothing, never everything. Untagged
   * (pending) statuses only appear when nothing is filtered.
   */
  async feed(viewerId: string, { limit }: FeedQueryDto) {
    const filter = await this.getFilter(viewerId);
    if (filter.query && filter.concepts.length === 0) return [];

    const params: unknown[] = [viewerId];
    const where = [
      `s.user_id IN (SELECT contact_id FROM contacts WHERE user_id = $1)`,
      `s.expires_at > now()`,
    ];
    for (const concept of filter.concepts) {
      params.push(concept.filter((t) => t.weight >= EXACT_WEIGHT).map((t) => t.id));
      where.push(`s.tags && $${params.length}::text[]`);
    }
    if (filter.tags.length) {
      params.push(filter.tags);
      where.push(`s.tags ${filter.match === 'all' ? '@>' : '&&'} $${params.length}::text[]`);
    }

    // relevance = weight of the search tags the status has / weight of all search tags.
    let relevance = '';
    let orderBy = 's.created_at DESC';
    const weighted = searchWeights(filter.concepts);
    if (weighted.length) {
      params.push(JSON.stringify(weighted));
      const total = weighted.reduce((sum, t) => sum + t.weight, 0);
      relevance = `, round((SELECT coalesce(sum(w.weight), 0) / ${total}
                             FROM jsonb_to_recordset($${params.length}::jsonb) AS w(id text, weight float8)
                            WHERE w.id = ANY(s.tags))::numeric, 2)::float AS "relevance"`;
      orderBy = `"relevance" DESC, s.created_at DESC`;
    }

    params.push(limit);
    return this.db.query(
      `SELECT ${STATUS_COLUMNS},
              EXISTS (SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) AS "seen"
              ${relevance}
         FROM statuses s JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${params.length}`,
      params,
    );
  }

  /** Self-learning: adds freshly created tags to the live statuses they fit. */
  private async applyNewTags(tags: Tag[]) {
    const rows: { id: string; text: string }[] = await this.db.query(
      `SELECT id, text FROM statuses
        WHERE expires_at > now() AND state = 'classified'
        ORDER BY created_at DESC LIMIT $1`,
      [BACKFILL_LIMIT],
    );
    const fits = await this.tagging.fits(tags, rows);
    for (const [statusId, tagIds] of fits) {
      await this.db.query(
        `UPDATE statuses SET tags = tags || ARRAY(SELECT unnest($2::text[]) EXCEPT SELECT unnest(tags))
          WHERE id = $1`,
        [statusId, tagIds],
      );
      await this.realtime.publishStatus('status.classified', statusId);
    }
    this.logger.log(
      `Learned tags ${tags.map((t) => t.id).join(', ')}; applied to ${fits.size}/${rows.length} live statuses`,
    );
  }

  async markViewed(viewerId: string, statusId: string) {
    const visible: { user_id: string }[] = await this.db.query(
      `SELECT s.user_id FROM statuses s
        WHERE s.id = $1 AND s.expires_at > now()
          AND s.user_id IN (SELECT contact_id FROM contacts WHERE user_id = $2)`,
      [statusId, viewerId],
    );
    if (visible.length === 0) throw new NotFoundException();
    const inserted: { viewerName: string }[] = await this.db.query(
      `INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
       RETURNING (SELECT name FROM users WHERE id = $2) AS "viewerName"`,
      [statusId, viewerId],
    );
    // Notify the owner on the first view only.
    if (inserted.length > 0) {
      this.realtime.publishViewed(visible[0].user_id, {
        statusId,
        viewerId,
        viewerName: inserted[0].viewerName,
      });
    }
  }

  async viewers(ownerId: string, statusId: string) {
    await this.findOwn(ownerId, statusId);
    return this.db.query(
      `SELECT u.id, u.name, v.viewed_at AS "viewedAt"
         FROM status_views v JOIN users u ON u.id = v.viewer_id
        WHERE v.status_id = $1 ORDER BY v.viewed_at DESC`,
      [statusId],
    );
  }

  async remove(ownerId: string, statusId: string) {
    await this.findOwn(ownerId, statusId);
    await this.repo.delete({ id: statusId });
    await this.realtime.publishDeleted(ownerId, statusId);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired() {
    const [, count] = await this.db.query(`DELETE FROM statuses WHERE expires_at <= now()`);
    if (count) this.logger.log(`Purged ${count} expired statuses`);
  }
}

/** Every search tag once, with its highest weight across concepts. */
function searchWeights(concepts: WeightedTag[][]): WeightedTag[] {
  const best = new Map<string, number>();
  for (const t of concepts.flat()) best.set(t.id, Math.max(t.weight, best.get(t.id) ?? 0));
  return [...best].map(([id, weight]) => ({ id, weight }));
}
