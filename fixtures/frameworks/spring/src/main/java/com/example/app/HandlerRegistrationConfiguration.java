package com.example.app;

import java.lang.reflect.Method;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

@Configuration
public class HandlerRegistrationConfiguration {

	// The actuator declares a RequestMappingHandlerMapping of its own: name the one for controllers.
	@Autowired
	public void setHandlerMapping(@Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mapping, UserHandler handler) throws NoSuchMethodException {
		RequestMappingInfo info = RequestMappingInfo.paths("/user/{id}").methods(RequestMethod.GET).build();
		Method method = UserHandler.class.getMethod("getUser", Long.class);
		mapping.registerMapping(info, handler, method);
	}
}
