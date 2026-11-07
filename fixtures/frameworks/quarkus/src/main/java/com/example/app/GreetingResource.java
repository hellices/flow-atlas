package com.example.app;

public class GreetingResource implements GreetingApi {

	@Override
	public String greet(String name) {
		return "Hello " + name;
	}

	@Override
	public String create(String greeting) {
		return greeting;
	}
}
