import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Order {
  id: string;
  status: string;
}

/** Writes paths alone: the API interceptor puts the API's base URL before them. */
@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);

  search(term: string): Observable<Order[]> {
    return this.http.get<Order[]>('/orders/search', { params: { q: term, sort: 'recent' } });
  }

  items(orderId: string): Observable<unknown[]> {
    return this.http.get<unknown[]>(`/orders/${orderId}/items`);
  }

  cancel(orderId: string, reason: string): Observable<Order> {
    return this.http.post<Order>('/orders/' + orderId + '/cancel', { reason }, { headers: { 'X-Audit': 'cancel' } });
  }

  addNote(orderId: string, note: string): Observable<Order> {
    return this.http.request<Order>('PUT', `/orders/${orderId}/note`, { body: { note } });
  }
}
