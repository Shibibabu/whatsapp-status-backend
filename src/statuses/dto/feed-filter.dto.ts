import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WeightedTag } from '../../tagging/tagging.service';

/** A user's saved feed filter (table feed_filters). */
export interface FeedFilter {
  /** What they typed, e.g. "laptops for sale". Empty = no search. */
  query: string;
  /**
   * `query` resolved to weighted tags, one array per concept. A status needs an exact
   * tag (weight 1) from each concept; related tags (lower weight) only raise its score.
   */
  concepts: WeightedTag[][];
  /** Tag chips picked directly. */
  tags: string[];
  /** How picked chips combine: any of them or all of them. */
  match: 'any' | 'all';
}

/** PUT /statuses/filter. Replaces the whole filter; an empty body resets it to "All". */
export class SaveFilterDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(200)
  query?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[a-z0-9_]{1,40}$/, { each: true, message: 'each tag must be a tag id like "food_travel"' })
  tags?: string[];

  @IsOptional()
  @IsIn(['any', 'all'])
  match?: 'any' | 'all';
}
