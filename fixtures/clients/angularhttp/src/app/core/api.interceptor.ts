import { HttpHandlerFn, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { environment } from '../../environments/environment';

/** Sends a request written with a path alone to the API, with the app's headers. */
export const apiInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  if (/^https?:\/\//.test(req.url)) {
    return next(req);
  }
  return next(
    req.clone({
      url: `${environment.apiUrl}${req.url}`,
      setHeaders: { 'X-Requested-With': 'XMLHttpRequest' },
    }),
  );
};
