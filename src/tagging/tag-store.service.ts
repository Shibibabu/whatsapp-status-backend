import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { rename, writeFile } from 'fs/promises';
import { resolve } from 'path';

export const TAG_GROUPS = ['category', 'type', 'topic', 'mood'] as const;
export type TagGroup = (typeof TAG_GROUPS)[number];

export interface Tag {
  id: string;
  group: TagGroup;
  label: string;
  description: string;
}

/** Normalises any label or id to a tag id: "Food & Travel" -> "food_travel". */
export function toTagId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * The shared tag list, kept in a JSON file (TAGS_FILE, default data/tags.json)
 * and cached in memory. New tags are appended to the file as they're created.
 *
 * Single-instance only: with several app instances, move tags into a database table.
 */
@Injectable()
export class TagStore {
  private readonly logger = new Logger(TagStore.name);
  private readonly file: string;
  private readonly tags = new Map<string, Tag>();
  private saving: Promise<void> = Promise.resolve();

  constructor(config: ConfigService) {
    this.file = resolve(config.get<string>('TAGS_FILE', 'data/tags.json'));
    const { tags } = JSON.parse(readFileSync(this.file, 'utf8')) as { tags: Tag[] };
    for (const t of tags) this.tags.set(t.id, t);
    this.logger.log(`Loaded ${this.tags.size} tags from ${this.file}`);
  }

  all(): Tag[] {
    return [...this.tags.values()];
  }

  get(id: string): Tag | undefined {
    return this.tags.get(id);
  }

  /** Adds tags whose ids don't exist yet and saves the file. Existing tags are never changed. */
  async add(tags: Tag[]): Promise<void> {
    const fresh = tags.filter((t) => !this.tags.has(t.id));
    if (fresh.length === 0) return;
    for (const t of fresh) this.tags.set(t.id, t);
    this.logger.log(`New tags: ${fresh.map((t) => `${t.group}/${t.id}`).join(', ')}`);

    // Chain writes so concurrent jobs never interleave; each write saves the full current list.
    this.saving = this.saving
      .then(() => this.write())
      .catch((e) => this.logger.error(`Failed to save ${this.file}: ${e}`));
    await this.saving;
  }

  /** Writes to a temp file and renames it, so a crash never leaves a half-written file. */
  private async write() {
    const sorted = this.all().sort(
      (a, b) => TAG_GROUPS.indexOf(a.group) - TAG_GROUPS.indexOf(b.group) || a.id.localeCompare(b.id),
    );
    const body = `{\n  "tags": [\n${sorted.map((t) => `    ${JSON.stringify(t)}`).join(',\n')}\n  ]\n}\n`;
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.file);
  }
}
