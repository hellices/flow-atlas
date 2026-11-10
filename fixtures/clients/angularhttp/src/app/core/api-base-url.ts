import { InjectionToken } from '@angular/core';

/** The base URL of the reporting API, provided in app.config.ts. */
export const REPORTS_API_URL = new InjectionToken<string>('REPORTS_API_URL');
