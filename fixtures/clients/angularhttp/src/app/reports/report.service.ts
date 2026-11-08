import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { REPORTS_API_URL } from '../core/api-base-url';

export interface Report {
  year: number;
  total: number;
}

@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(REPORTS_API_URL);

  yearly(year: number): Observable<Report> {
    return this.http.get<Report>(`${this.baseUrl}/${year}`);
  }

  export(year: number, format: string): Observable<string> {
    return this.http.post(`${this.baseUrl}/${year}/export`, null, {
      params: { format },
      responseType: 'text',
    });
  }
}
