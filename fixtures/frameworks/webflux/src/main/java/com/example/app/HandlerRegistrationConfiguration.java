package com.example.app;

import java.lang.reflect.Method;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.reactive.result.method.RequestMappingInfo;
import org.springframework.web.reactive.result.method.annotation.RequestMappingHandlerMapping;

/** The explicit registration of the guide: a handler method mapped in code. */
@Configuration
public class HandlerRegistrationConfiguration {

	@Autowired
	public void setHandlerMapping(@Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mapping, UserHandler handler) throws NoSuchMethodException {
		RequestMappingInfo info = RequestMappingInfo.paths("/user/{id}").methods(RequestMethod.GET).build();
		Method method = UserHandler.class.getMethod("getUser", Long.class);
		mapping.registerMapping(info, handler, method);
	}
}
