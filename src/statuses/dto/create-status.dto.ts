import { IsHexColor, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateStatusDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 700)
  text: string;

  @IsOptional()
  @IsHexColor()
  bgColor?: string;
}
