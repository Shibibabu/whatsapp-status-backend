import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** GET /statuses/feed. Filtering comes from the viewer's saved filter (PUT /statuses/filter). */
export class FeedQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
