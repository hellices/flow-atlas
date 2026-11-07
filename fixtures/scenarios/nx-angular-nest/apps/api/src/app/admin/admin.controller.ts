import { Controller, Delete, Get } from '@nestjs/common';

import { AdminService } from './admin.service';

@Controller('api/v1/admin')
export class AdminController {
  public constructor(private readonly adminService: AdminService) {}

  @Get()
  public async getAdminData() {
    return this.adminService.get();
  }

  @Get('queue/jobs')
  public async getJobs() {
    return this.adminService.getJobs();
  }

  @Delete('queue/jobs')
  public async deleteJobs() {
    return this.adminService.deleteJobs();
  }
}
