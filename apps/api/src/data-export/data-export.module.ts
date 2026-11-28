import { Global, Module } from '@nestjs/common';
import { UserDataExportRegistry } from './user-data-export.registry.js';
import { UserDataExportService } from './user-data-export.service.js';

/**
 * Platform area for the user's data export (backlog P2-10, ADR-0025). `@Global()` so every
 * feature module can inject the registry and register its contributor without importing this
 * module (the composition root imports it once, before the feature modules).
 */
@Global()
@Module({
  providers: [UserDataExportRegistry, UserDataExportService],
  exports: [UserDataExportRegistry, UserDataExportService],
})
export class DataExportModule {}
