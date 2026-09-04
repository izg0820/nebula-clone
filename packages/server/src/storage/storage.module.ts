import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/** SQLite 커넥션 전역 제공 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class StorageModule {}
