import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('contacts')
export class Contact {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @PrimaryColumn('uuid', { name: 'contact_id' })
  contactId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
