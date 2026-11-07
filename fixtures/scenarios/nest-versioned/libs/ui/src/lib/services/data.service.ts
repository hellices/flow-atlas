import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class DataService {
  public constructor(private http: HttpClient) {}

  public fetchOrders() {
    return this.http.get<unknown[]>('/api/v1/orders');
  }

  public fetchOrder(id: string) {
    return this.http.get<unknown>(`/api/v1/orders/${id}`);
  }

  public postOrder(order: unknown) {
    return this.http.post<unknown>('/api/v1/orders', order);
  }

  public fetchPerformance() {
    return this.http.get<unknown>('/api/v2/portfolio/performance');
  }

  public fetchReports() {
    return this.http.get<unknown[]>('/api/v2/reports');
  }

  public loginAnonymous() {
    return this.http.post<unknown>('/api/v1/auth/anonymous', {});
  }

  public fetchWebManifest(languageCode: string) {
    return this.http.get<unknown>(`/api/assets/${languageCode}/site.webmanifest`);
  }
}
