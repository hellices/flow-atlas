import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { apiInterceptor } from './core/api.interceptor';
import { REPORTS_API_URL } from './core/api-base-url';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withFetch(), withInterceptors([apiInterceptor])),
    { provide: REPORTS_API_URL, useFactory: () => `${environment.apiUrl}/v2/reports` },
  ],
};
