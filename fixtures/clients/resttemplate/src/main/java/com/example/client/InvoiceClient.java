package com.example.client;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class InvoiceClient {

	private final RestTemplate restTemplate = new RestTemplate();

	private final String url;

	public InvoiceClient(@Value("${billing.url}") String url) {
		this.url = url;
	}

	public Invoice getInvoice(long id) {
		return this.restTemplate.getForObject(this.url + "/invoices/{id}", Invoice.class, id);
	}

	public Map<?, ?> searchInvoices(String status) {
		String uri = UriComponentsBuilder.fromUriString(this.url)
			.path("/invoices")
			.queryParam("status", status)
			.toUriString();
		return this.restTemplate.getForObject(uri, Map.class);
	}

	public ResponseEntity<Payment> payInvoice(long id, Payment payment) {
		return this.restTemplate.postForEntity(this.url + "/invoices/{id}/payments", payment, Payment.class, id);
	}

	public void voidInvoice(String number) {
		this.restTemplate.exchange(this.url + "/invoices/" + number, HttpMethod.DELETE, null, Void.class);
	}

}
