import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type StatusState = 'pending' | 'classified' | 'failed';

@Entity('statuses')
export class Status {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'user_id' })
  userId: string;

  @Column()
  text: string;

  @Column({ name: 'bg_color' })
  bgColor: string;

  /** Tag ids from data/tags.json, set by the tagging job. Empty while pending. */
  @Column('text', { array: true })
  tags: string[];

  @Column({ type: 'enum', enum: ['pending', 'classified', 'failed'], enumName: 'status_state' })
  state: StatusState;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
