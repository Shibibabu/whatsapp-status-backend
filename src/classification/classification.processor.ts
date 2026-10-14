import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import OpenAI from 'openai';
import { DataSource } from 'typeorm';
import { RealtimeService } from '../realtime/realtime.service';
import { TaggingService } from '../tagging/tagging.service';
import { CLASSIFY_QUEUE, ClassifyJob } from './classification.constants';

/** Tags each new status with OpenAI in the background. */
@Processor(CLASSIFY_QUEUE, { concurrency: 4 })
export class ClassificationProcessor extends WorkerHost {
  private readonly logger = new Logger(ClassificationProcessor.name);

  constructor(
    private readonly tagging: TaggingService,
    @InjectDataSource() private readonly db: DataSource,
    private readonly realtime: RealtimeService,
  ) {
    super();
  }

  async process(job: Job<ClassifyJob>): Promise<void> {
    const { statusId } = job.data;
    const rows: { text: string }[] = await this.db.query(
      `SELECT text FROM statuses WHERE id = $1 AND expires_at > now()`,
      [statusId],
    );
    if (rows.length === 0) return; // deleted or expired before we got to it

    try {
      if (!this.tagging.enabled) throw new UnrecoverableError('OPENAI_API_KEY is not set');
      const tags = await this.tagging.tag(rows[0].text);
      await this.db.query(`UPDATE statuses SET tags = $2, state = 'classified' WHERE id = $1`, [statusId, tags]);
      this.logger.debug(`Status ${statusId} -> ${tags.join(', ')}`);
    } catch (e) {
      const permanent = isPermanent(e);
      this.logger.warn(`Tagging status ${statusId} failed${permanent ? ' (not retrying)' : ''}: ${e}`);
      // Mark as failed once retries are exhausted, or straight away if retrying can't help.
      if (permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.db.query(`UPDATE statuses SET state = 'failed' WHERE id = $1`, [statusId]);
        await this.realtime.publishStatus('status.classified', statusId);
      }
      throw permanent && !(e instanceof UnrecoverableError) ? new UnrecoverableError(String(e)) : e;
    }
    await this.realtime.publishStatus('status.classified', statusId);
  }
}

/** Errors a retry won't fix: missing key, bad request/auth/model, or no credits. */
function isPermanent(e: unknown): boolean {
  if (e instanceof UnrecoverableError) return true;
  if (!(e instanceof OpenAI.APIError)) return false;
  return [400, 401, 403, 404].includes(e.status ?? 0) || e.code === 'insufficient_quota';
}
