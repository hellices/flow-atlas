package com.example.app;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import jakarta.ws.rs.HttpMethod;

/** A method of the application's own. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@HttpMethod("CHEESE")
public @interface CHEESE {
}
