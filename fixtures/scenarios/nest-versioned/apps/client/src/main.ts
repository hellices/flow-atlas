import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';

(async () => {
  const response = await fetch('/api/v1/info');
  const info = await response.json();

  await bootstrapApplication(AppComponent, { providers: [{ provide: 'info', useValue: info }] });
})();
