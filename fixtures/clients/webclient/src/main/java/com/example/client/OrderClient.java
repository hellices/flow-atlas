package com.example.client;

import java.util.Map;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

@Component
public class OrderClient {

	private final WebClient webClient;

	public OrderClient(WebClient webClient) {
		this.webClient = webClient;
	}

	public Mono<Order> getOrder(long id) {
		return this.webClient.get()
			.uri("/orders/{id}", id)
			.retrieve()
			.bodyToMono(Order.class);
	}

	public Flux<Order> listOrders(String status, int page) {
		return this.webClient.get()
			.uri(builder -> builder.path("/orders").queryParam("status", status).queryParam("page", page).build())
			.retrieve()
			.bodyToFlux(Order.class);
	}

	public Mono<Order> createOrder(OrderForm form) {
		return this.webClient.post()
			.uri("/orders")
			.contentType(MediaType.APPLICATION_JSON)
			.bodyValue(form)
			.retrieve()
			.bodyToMono(Order.class);
	}

	public Mono<Order> replaceOrder(long id, OrderForm form) {
		return this.webClient.put()
			.uri("/orders/{id}", id)
			.contentType(MediaType.APPLICATION_JSON)
			.body(Mono.just(form), OrderForm.class)
			.retrieve()
			.bodyToMono(Order.class);
	}

	public Mono<Order> updateStatus(long id, String status) {
		return this.webClient.patch()
			.uri("/orders/{id}", id)
			.bodyValue(Map.of("status", status))
			.retrieve()
			.bodyToMono(Order.class);
	}

	public Mono<Void> cancelOrder(long id) {
		return this.webClient.delete()
			.uri("/orders/{id}", id)
			.retrieve()
			.bodyToMono(Void.class);
	}

	public Mono<Refund> refundOrder(long id, Refund refund) {
		return this.webClient.method(HttpMethod.POST)
			.uri("/orders/{id}/refunds", id)
			.bodyValue(refund)
			.retrieve()
			.bodyToMono(Refund.class);
	}

	public Mono<Void> setItemQuantity(long id, String sku, int quantity) {
		return this.webClient.method(HttpMethod.PUT)
			.uri("/orders/{id}/items/{sku}", id, sku)
			.bodyValue(Map.of("quantity", quantity))
			.retrieve()
			.toBodilessEntity()
			.then();
	}

	public Mono<Boolean> orderExists(long id) {
		return this.webClient.head()
			.uri("/orders/{id}", id)
			.exchangeToMono((response) -> response.releaseBody().thenReturn(response.statusCode().is2xxSuccessful()));
	}

	public Flux<Order> customerOrders(String customerId) {
		return this.webClient.get()
			.uri("/customers/" + customerId + "/orders")
			.retrieve()
			.bodyToFlux(Order.class);
	}

	public Mono<String> orderInvoice(long id, String format) {
		return this.webClient.get()
			.uri(builder -> builder.path("/orders/{id}/invoice").queryParam("format", format).build(id))
			.accept(MediaType.ALL)
			.exchangeToMono((response) -> response.bodyToMono(String.class));
	}

	public Mono<Map<String, Object>> orderOptions(long id) {
		return this.webClient.method(HttpMethod.OPTIONS)
			.uri("/orders/{id}", id)
			.retrieve()
			.toBodilessEntity()
			.map((response) -> Map.of("allow", response.getHeaders().getAllow()));
	}

}
