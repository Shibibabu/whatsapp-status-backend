import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import { Tag, TAG_GROUPS, TagGroup, TagStore, toTagId } from './tag-store.service';

const MAX_TOPICS = 3;

const TagRefSchema = z.object({ id: z.string(), label: z.string(), description: z.string() });
type TagRef = z.infer<typeof TagRefSchema>;

// One slot per group, so the model can't skip the category or the type.
const SuggestionSchema = z.object({
  category: TagRefSchema,
  type: TagRefSchema,
  topics: z.array(TagRefSchema),
  moods: z.array(TagRefSchema),
});
type Suggestion = z.infer<typeof SuggestionSchema>;

// Same shape as SuggestionSchema, as plain JSON Schema for OpenAI structured outputs.
const TAG_REF_JSON_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } },
  required: ['id', 'label', 'description'],
  additionalProperties: false,
};
const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: TAG_REF_JSON_SCHEMA,
    type: TAG_REF_JSON_SCHEMA,
    topics: { type: 'array', items: TAG_REF_JSON_SCHEMA },
    moods: { type: 'array', items: TAG_REF_JSON_SCHEMA },
  },
  required: ['category', 'type', 'topics', 'moods'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You tag short user-generated text, such as WhatsApp-style statuses.
The text may be in any language, use slang, or be mostly emojis.

Fill every field:
- category: the broad subject area. Required. If no existing category fits, create a new broad one
  (e.g. "Beauty & Fashion", "Shopping & Deals"), never a narrow one.
- type: what kind of post it is, i.e. the author's intent (selling something, asking, announcing, wishing...).
  Required. Prefer the most specific type: an item with a price or "for sale" is a sale, not an announcement.
- topics: 0-3 specific subjects, names, products, places or events it mentions (e.g. cricket, nodejs, diwali).
- moods: 0-1 feeling expressed, only if there is a clear one.

Reuse an existing tag whenever one fits: return its exact id from the list (label and description may then be
empty strings). Only create a new tag when nothing fits; then set id to "", and give a short English label
naming just the thing (e.g. "Makeup", not "New makeup") and a one-line English description.
Never create a near-duplicate of an existing tag (e.g. "Node JS" when "Node.js" exists).`;

const NewTagSchema = z.object({ group: z.enum(TAG_GROUPS), label: z.string(), description: z.string() });
const MatchSchema = z.object({
  concepts: z.array(
    z.object({
      existing: z.array(z.object({ id: z.string(), relevance: z.enum(['exact', 'related']) })),
      new_tag: NewTagSchema.nullable(),
    }),
  ),
});
const MATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          existing: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, relevance: { type: 'string', enum: ['exact', 'related'] } },
              required: ['id', 'relevance'],
              additionalProperties: false,
            },
          },
          new_tag: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  group: { type: 'string', enum: TAG_GROUPS },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['group', 'label', 'description'],
                additionalProperties: false,
              },
              { type: 'null' },
            ],
          },
        },
        required: ['existing', 'new_tag'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
};
const MATCH_CACHE_SIZE = 500;
const STOP_WORDS = new Set(
  'the and for with that this from about some something anything want show see get make made more any all '
    .concat('what who how why when where are was were has have had not but you your our their its can will just ')
    .concat('only status statuses post posts people')
    .split(' '),
);

const MATCH_PROMPT = `A user is filtering WhatsApp-style statuses by typing what they want to see.
Split the search into the distinct things they ask for ("concepts"). Usually there is one;
"laptops for sale" has two (laptops, for sale). Ignore filler such as "I want to see", "show me", "statuses", "only".

For each concept:
- existing: existing tags for it, each with a relevance:
  - "exact": the tag means what the user asked for. A status needs one of these to be shown.
  - "related": a broader or neighbouring tag. It only ranks a status higher; it never qualifies one alone.
  Examples: "birthday" -> birthday (exact), celebration (related), wish (related);
  "beauty" -> beauty_fashion (exact), makeup (exact); "something to make me laugh" -> funny (exact), joke (exact).
- new_tag: if no existing tag means what the user asked for, the tag to create for it, otherwise null. Pick the
  group: type for the post's intent (selling, asking, announcing...), topic for a specific thing, product, place or
  event (e.g. laptops, makeup), mood for a feeling, and category only for a broad subject area that no existing
  category covers. Give a short English label naming just the concept (e.g. "For sale") and a one-line
  description of which statuses it fits.

Only use ids from the list. Never create a near-duplicate of an existing tag.
Return no concepts if the search has no meaningful content.`;

const FitsSchema = z.object({ matches: z.array(z.object({ index: z.number().int(), tags: z.array(z.string()) })) });
const FITS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['index', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};
const FITS_BATCH_SIZE = 40;

const FITS_PROMPT = `You decide which tags apply to short user-generated texts (e.g. WhatsApp-style statuses).
You get a few tags and numbered texts. For each text that clearly fits one or more of the tags, return its
number and those tag ids. Leave out texts that fit none. Only use the given tag ids.`;

/** Result of mapping a search onto the tag list. */
/** Weight of a search tag that means what the user asked for; a status needs one per concept. */
export const EXACT_WEIGHT = 1;
/** Weight of a broader / neighbouring tag: it raises a status's score but never qualifies it alone. */
export const RELATED_WEIGHT = 0.4;

export interface WeightedTag {
  id: string;
  weight: number;
}

export interface QueryMatch {
  /**
   * One entry per thing the search asks for. A status satisfies a concept when it has
   * one of its exact tags (weight 1); related tags (weight < 1) only add to its score.
   */
  concepts: WeightedTag[][];
  /** Tags created because part of the search had no tag yet. */
  created: Tag[];
}

/**
 * Common tagging functions over the shared tag list (see TagStore): tag a text,
 * map a search onto tags (learning new ones), and check which texts a tag fits.
 * Not tied to statuses, so other features can tag their own content with it.
 */
@Injectable()
export class TaggingService {
  private readonly logger = new Logger(TaggingService.name);
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly matchCache = new Map<string, WeightedTag[][]>();

  constructor(
    private readonly store: TagStore,
    config: ConfigService,
  ) {
    this.model = config.get<string>('OPENAI_MODEL', 'gpt-5.4-mini');
    if (config.get<string>('OPENAI_API_KEY')) {
      this.client = new OpenAI();
    } else {
      this.logger.warn('OPENAI_API_KEY is not set; tagging is disabled');
    }
  }

  get enabled(): boolean {
    return !!this.client;
  }

  /**
   * Returns tag ids for `text`. Reuses existing tags where they fit and adds new
   * ones to the tag list when nothing does. Throws on API errors so callers can retry.
   */
  async tag(text: string): Promise<string[]> {
    const suggestion = await this.complete(
      SYSTEM_PROMPT,
      `Existing tags:\n${this.describeTags()}\n\nText:\n<text>\n${text}\n</text>`,
      'tags',
      SUGGESTION_JSON_SCHEMA,
      SuggestionSchema,
    );
    return this.resolve(suggestion);
  }

  /**
   * Maps a search ("beauty", "laptops for sale") onto the tag list, one entry per
   * concept in it. Self-learning: a concept with no matching tag gets a new tag,
   * which is saved and returned in `created` so callers can apply it to old content.
   */
  async match(query: string): Promise<QueryMatch> {
    const normalized = query.trim().toLowerCase();
    // The tag count is part of the key, so new tags invalidate cached answers.
    const key = `${this.store.all().length}:${normalized}`;
    const cached = this.matchCache.get(key);
    if (cached) return { concepts: cached, created: [] };

    const hints = this.wordMatch(normalized);
    const { concepts } = await this.complete(
      MATCH_PROMPT,
      `Existing tags:\n${this.describeTags()}\n\n` +
        (hints.length ? `Tags sharing words with the search (may help): ${hints.join(', ')}\n\n` : '') +
        `Search:\n<search>\n${normalized}\n</search>`,
      'search_concepts',
      MATCH_JSON_SCHEMA,
      MatchSchema,
    );

    const namedTags = new Set(this.nameMatch(normalized));
    const created: Tag[] = [];
    const result: WeightedTag[][] = [];
    for (const c of concepts) {
      const weights = new Map<string, number>(); // id -> highest weight given
      const give = (id: string, weight: number) => weights.set(id, Math.max(weight, weights.get(id) ?? 0));
      for (const t of c.existing) {
        const id = toTagId(t.id);
        if (this.store.get(id)) give(id, t.relevance === 'exact' ? EXACT_WEIGHT : RELATED_WEIGHT);
      }
      const label = c.new_tag?.label.trim();
      const newId = label ? toTagId(label) : '';
      if (c.new_tag && newId) {
        if (!this.store.get(newId) && !created.some((t) => t.id === newId)) {
          created.push({ id: newId, group: c.new_tag.group, label: label!, description: c.new_tag.description.trim() });
        }
        give(newId, EXACT_WEIGHT);
      }
      if (weights.size === 0) continue;
      // Named in the search ("birthday" -> the Birthday tag): those are what was asked for, and
      // the model's other picks for this concept only rank. Keeps "birthday" from matching any wish.
      const named = [...weights.keys()].filter((id) => namedTags.has(id));
      if (named.length) for (const id of weights.keys()) weights.set(id, named.includes(id) ? EXACT_WEIGHT : RELATED_WEIGHT);
      // A concept needs at least one exact tag; if the model marked none, treat them all as exact.
      if (![...weights.values()].includes(EXACT_WEIGHT)) for (const id of weights.keys()) weights.set(id, EXACT_WEIGHT);
      result.push([...weights].map(([id, weight]) => ({ id, weight })).sort((a, b) => b.weight - a.weight));
    }

    // The model occasionally returns nothing for an obvious match; fall back to shared words.
    // Tags named in the search are exact; ones that only mention a word in their description rank.
    if (result.length === 0 && created.length === 0 && hints.length > 0) {
      const anyNamed = hints.some((id) => namedTags.has(id));
      const weight = (id: string) => (!anyNamed || namedTags.has(id) ? EXACT_WEIGHT : RELATED_WEIGHT);
      result.push(hints.map((id) => ({ id, weight: weight(id) })).sort((x, y) => y.weight - x.weight));
    }

    await this.store.add(created);
    if (this.matchCache.size >= MATCH_CACHE_SIZE) this.matchCache.clear();
    this.matchCache.set(`${this.store.all().length}:${normalized}`, result);
    return { concepts: result, created };
  }

  /**
   * Which of `tags` apply to each item's text, e.g. to apply a newly created tag to
   * existing content. Returns item id -> tag ids, only for items that fit at least one.
   */
  async fits(tags: Tag[], items: { id: string; text: string }[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const allowed = new Set(tags.map((t) => t.id));
    const tagList = tags.map((t) => `${t.id} | ${t.label}: ${t.description}`).join('\n');

    for (let start = 0; start < items.length; start += FITS_BATCH_SIZE) {
      const batch = items.slice(start, start + FITS_BATCH_SIZE);
      const texts = batch.map((item, i) => `${i + 1}. ${item.text.replace(/\s+/g, ' ')}`).join('\n');
      const { matches } = await this.complete(
        FITS_PROMPT,
        `Tags:\n${tagList}\n\nTexts:\n<texts>\n${texts}\n</texts>`,
        'tag_fits',
        FITS_JSON_SCHEMA,
        FitsSchema,
      );
      for (const m of matches) {
        const item = batch[m.index - 1];
        const ids = m.tags.map(toTagId).filter((id) => allowed.has(id));
        if (item && ids.length) result.set(item.id, [...new Set(ids)]);
      }
    }
    return result;
  }

  /** Tags whose label, id or description contains a whole word of the query. */
  private wordMatch(query: string): string[] {
    return this.tagsMentioning(query, (t) => `${t.label} ${t.id.replace(/_/g, ' ')} ${t.description}`);
  }

  /** Tags whose own name (label or id) contains a whole word of the query. */
  private nameMatch(query: string): string[] {
    return this.tagsMentioning(query, (t) => `${t.label} ${t.id.replace(/_/g, ' ')}`);
  }

  private tagsMentioning(query: string, text: (t: Tag) => string): string[] {
    const words = query.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    // Each word plus its singular forms: "sales" -> sale, "wishes" -> wishe, wish.
    const forms = [...new Set(words.flatMap((w) => [w, w.replace(/s$/, ''), w.replace(/es$/, '')]))].filter(
      (f) => f.length >= 3,
    );
    if (forms.length === 0) return [];
    const pattern = new RegExp(`\\b(${forms.join('|')})(s|es)?\\b`);
    return this.store
      .all()
      .filter((t) => pattern.test(text(t).toLowerCase()))
      .map((t) => t.id);
  }

  /** One structured-output call to OpenAI, validated with `zodSchema`. */
  private async complete<T>(
    system: string,
    user: string,
    name: string,
    jsonSchema: object,
    zodSchema: z.ZodType<T>,
  ): Promise<T> {
    if (!this.client) throw new Error('OPENAI_API_KEY is not set');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema as Record<string, unknown> } },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const message = response.choices[0]?.message;
    if (message?.refusal) throw new Error(`Model refused: ${message.refusal}`);
    const content = message?.content;
    if (!content) throw new Error(`Empty response (finish_reason=${response.choices[0]?.finish_reason})`);
    return zodSchema.parse(JSON.parse(content));
  }

  /** One line per tag, grouped, e.g. "category | sports | Sports: Cricket, football, ..." */
  private describeTags(): string {
    return this.store
      .all()
      .sort((a, b) => TAG_GROUPS.indexOf(a.group) - TAG_GROUPS.indexOf(b.group))
      .map((t) => `${t.group} | ${t.id} | ${t.label}: ${t.description}`)
      .join('\n');
  }

  /** Maps suggestions onto the tag list: known tags are reused, unknown ones are created. */
  private async resolve(s: Suggestion): Promise<string[]> {
    const slots: [TagGroup, TagRef][] = [
      ['category', s.category],
      ['type', s.type],
      ...s.topics.slice(0, MAX_TOPICS).map((t): [TagGroup, TagRef] => ['topic', t]),
      ...s.moods.slice(0, 1).map((t): [TagGroup, TagRef] => ['mood', t]),
    ];
    const ids: string[] = [];
    const created: Tag[] = [];

    for (const [group, ref] of slots) {
      const existing = this.store.get(toTagId(ref.id)) ?? this.store.get(toTagId(ref.label));
      // New ids come from the label, so the model can't invent ids like "new_makeup".
      const tag: Tag = existing ?? {
        id: toTagId(ref.label) || toTagId(ref.id),
        group,
        label: ref.label.trim() || ref.id.trim(),
        description: ref.description.trim(),
      };
      if (!tag.id || ids.includes(tag.id)) continue;
      if (existing && existing.group !== group) {
        this.logger.warn(`Model used ${existing.group} tag "${existing.id}" as a ${group}`);
      }
      if (!existing && !created.some((c) => c.id === tag.id)) created.push(tag);
      ids.push(tag.id);
    }

    await this.store.add(created);
    return ids;
  }
}
