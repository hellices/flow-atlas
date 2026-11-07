import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';

import { ENVIRONMENT, Environment } from '../environment';

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  public constructor(
    @Inject(ENVIRONMENT) private environment: Environment,
    private http: HttpClient
  ) {}

  public fetchAdminData() {
    return this.http.get<Record<string, unknown>>('/api/v1/admin');
  }

  public fetchJobs() {
    return this.http.get<unknown[]>('/api/v1/admin/queue/jobs');
  }

  public fetchRemoteStatus(aApiKey: string) {
    const headers = new HttpHeaders({ Authorization: `Api-Key ${aApiKey}` });

    return this.http.get<{ status: string }>(
      `${this.environment.production ? 'https://remote.example' : ''}/api/v2/data-providers/remote/status`,
      { headers }
    );
  }
}
