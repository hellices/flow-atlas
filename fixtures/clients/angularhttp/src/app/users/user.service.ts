import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface User {
  id: string;
  name: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class UserService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/users`;

  list(page: number): Observable<User[]> {
    const params = new HttpParams().set('page', page).set('size', 20);
    return this.http.get<User[]>(this.base, { params });
  }

  get(id: string): Observable<User> {
    return this.http.get<User>(`${this.base}/${id}`);
  }

  create(user: Partial<User>): Observable<User> {
    return this.http.post<User>(this.base, user, {
      headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
    });
  }

  update(id: string, user: User): Observable<User> {
    return this.http.put<User>(`${this.base}/${id}`, user);
  }

  rename(id: string, name: string): Observable<User> {
    return this.http.patch<User>(`${this.base}/${id}`, { name });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }

  avatar(id: string): Observable<Blob> {
    return this.http.get(environment.apiUrl + '/users/' + id + '/avatar', { responseType: 'blob' });
  }
}
