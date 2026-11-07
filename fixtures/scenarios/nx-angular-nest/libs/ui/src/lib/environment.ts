import { InjectionToken } from '@angular/core';

export interface Environment {
  production: boolean;
}

export const ENVIRONMENT = new InjectionToken<Environment>('ENVIRONMENT');
