package com.example.events;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/events")
public class EventController {

    @GetMapping("/opt_out")
    public Object optOut() { return null; }

    @PostMapping("/page_view")
    public Object pageView() { return null; }

    @PostMapping("/click")
    public Object click() { return null; }

    @PostMapping("/session")
    public Object session() { return null; }

    @PostMapping("/consent")
    public Object consent() { return null; }
}
