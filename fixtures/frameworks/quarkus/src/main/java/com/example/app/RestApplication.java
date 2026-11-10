package com.example.app;

import jakarta.ws.rs.ApplicationPath;
import jakarta.ws.rs.core.Application;

/** The root path of every REST endpoint; reactive routes are not under it. */
@ApplicationPath("/api")
public class RestApplication extends Application {
}
