import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminModule } from './admin/admin.module.js';
import { DashboardModule } from './admin/dashboard/dashboard.module.js';
import { MetricsModule } from './admin/metrics/metrics.module.js';
import { AppController } from './app.controller.js';
import { CatsModule } from './cats/cats.module.js';
import { DogsModule } from './dogs/dogs.module.js';
import { PingController } from './ping/ping.controller.js';

@Module({
  imports: [
    CatsModule,
    DogsModule,
    AdminModule,
    DashboardModule,
    MetricsModule,
    RouterModule.register([
      {
        path: 'admin',
        module: AdminModule,
        children: [
          { path: 'dashboard', module: DashboardModule },
          { path: 'metrics', module: MetricsModule },
        ],
      },
    ]),
  ],
  controllers: [AppController, PingController],
})
export class AppModule {}
